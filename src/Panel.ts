/* eslint max-lines:0 */

import {
    _, CodeInspection, CommandManager, Commands, Dialogs, DocumentManager, EditorManager,
    FileViewController, KeyBindingManager, FileSystem, Menus, Mustache, FindInFiles,
    WorkspaceManager, ProjectManager, StringUtils
} from "./brackets-modules";
import * as moment from "moment";
import * as Promise from "bluebird";
import * as Git from "./git/GitCli";
import * as Git2 from "./git/Git";
import * as Events from "./Events";
import EventEmitter from "./EventEmitter";
import * as Preferences from "./Preferences";
import * as ErrorHandler from "./ErrorHandler";
import ExpectedError from "./ExpectedError";
import * as Main from "./Main";
import * as GutterManager from "./GutterManager";
import * as Strings from "strings";
import * as Utils from "./Utils";
import * as SettingsDialog from "./SettingsDialog";
import * as ProgressDialog from "./dialogs/Progress";

const PANEL_COMMAND_ID = "quadre-git.panel";

import gitPanelTemplate = require("text!templates/git-panel.html");
import gitPanelResultsTemplate = require("text!templates/git-panel-results.html");
import gitAuthorsDialogTemplate = require("text!templates/authors-dialog.html");
import gitCommitDialogTemplate = require("text!templates/git-commit-dialog.html");
import gitTagDialogTemplate = require("text!templates/git-tag-dialog.html");
import gitDiffDialogTemplate = require("text!templates/git-diff-dialog.html");
import questionDialogTemplate = require("text!templates/git-question-dialog.html");

const showFileWhiteList = /^\.gitignore$/;

const COMMIT_MODE = {
    CURRENT: "CURRENT",
    ALL: "ALL",
    DEFAULT: "DEFAULT"
};

let gitPanel = null;
let $gitPanel = $(null);
let gitPanelDisabled = null;
let gitPanelMode = null;
let showingUntracked = true;
let $tableContainer = $(null);
let lastCommitMessage = null;

function lintFile(filename) {
    const fullPath = Preferences.get("currentGitRoot") + filename;
    let codeInspectionPromise;

    try {
        codeInspectionPromise = CodeInspection.inspectFile(FileSystem.getFileForPath(fullPath));
    } catch (e) {
        ErrorHandler.logError("CodeInspection.inspectFile failed to execute for file " + fullPath);
        ErrorHandler.logError(e);
        codeInspectionPromise = Promise.reject(e);
    }

    return Promise.cast(codeInspectionPromise);
}

function _makeDialogBig($dialog) {
    const $wrapper = $dialog.parents(".modal-wrapper").first();
    if ($wrapper.length === 0) { return null; }

    // We need bigger commit dialog
    const minWidth = 500;
    const minHeight = 300;
    const maxWidth = $wrapper.width();
    const maxHeight = $wrapper.height();
    let desiredWidth = maxWidth / 1.5;
    let desiredHeight = maxHeight / 2;

    if (desiredWidth < minWidth) { desiredWidth = minWidth; }
    if (desiredHeight < minHeight) { desiredHeight = minHeight; }

    $dialog
        .width(desiredWidth)
        .children(".modal-body")
        .css("max-height", desiredHeight)
        .end();

    return { width: desiredWidth, height: desiredHeight };
}

function _showCommitDialog(stagedDiff, _lintResults, prefilledMessage, commitMode, files) {
    let lintResults = _lintResults || [];

    // Flatten the error structure from various providers
    lintResults.forEach((lintResult) => {
        lintResult.errors = [];
        if (Array.isArray(lintResult.result)) {
            lintResult.result.forEach((resultSet) => {
                if (!resultSet.result || !resultSet.result.errors) { return; }

                const providerName = resultSet.provider.name;
                resultSet.result.errors.forEach((e) => {
                    lintResult.errors.push((e.pos.line + 1) + ": " + e.message + " (" + providerName + ")");
                });
            });
        } else {
            ErrorHandler.logError(
                "[quadre-git] lintResults contain object in unexpected format: " + JSON.stringify(lintResult)
            );
        }
        lintResult.hasErrors = lintResult.errors.length > 0;
    });

    // Filter out only results with errors to show
    lintResults = _.filter(lintResults, (lintResult) => lintResult.hasErrors);

    // Open the dialog
    const compiledTemplate = Mustache.render(gitCommitDialogTemplate, {
        Strings,
        hasLintProblems: lintResults.length > 0,
        lintResults
    });
    const dialog = Dialogs.showModalDialogUsingTemplate(compiledTemplate);
    const $dialog = dialog.getElement();

    // We need bigger commit dialog
    _makeDialogBig($dialog);

    // Show nicely colored commit diff
    $dialog.find(".commit-diff").append(Utils.formatDiff(stagedDiff));

    // Enable / Disable amend checkbox
    function toggleAmendCheckbox(bool) {
        $dialog.find(".amend-commit")
            .prop("disabled", !bool)
            .parent()
            .attr("title", !bool ? Strings.AMEND_COMMIT_FORBIDDEN : null);
    }
    toggleAmendCheckbox(false);

    Git.getCommitCounts()
        .then((commits) => {
            const hasRemote = $gitPanel.find(".git-selected-remote").data("remote") != null;
            const hasCommitsAhead = commits.ahead > 0;
            toggleAmendCheckbox(!hasRemote || hasRemote && hasCommitsAhead);
        })
        .catch((err) => ErrorHandler.logError(err));

    function getCommitMessageElement() {
        let r = $dialog.find("[name='commit-message']:visible");
        if (r.length !== 1) {
            r = $dialog.find("[name='commit-message']").toArray();
            for (const ri of r) {
                const $ri = $(ri);
                if ($ri.css("display") !== "none") {
                    return $ri;
                }
            }
        }
        return r;
    }

    const $commitMessageCount = $dialog.find("input[name='commit-message-count']");

    // Add event to count characters in commit message
    function recalculateMessageLength() {
        const val = getCommitMessageElement().val().trim();
        let length = val.length;

        if (val.indexOf("\n")) {
            // longest line
            const lengths = val.split("\n").map((l) => l.length);
            length = Math.max(...lengths);
        }

        $commitMessageCount
            .val(length)
            .toggleClass("over50", length > 50 && length <= 100)
            .toggleClass("over100", length > 100);
    }

    let usingTextArea = false;

    // commit message handling
    function switchCommitMessageElement() {
        usingTextArea = !usingTextArea;

        const findStr = "[name='commit-message']";
        const currentValue = $dialog.find(findStr + ":visible").val();
        $dialog.find(findStr).toggle();
        $dialog.find(findStr + ":visible")
            .val(currentValue)
            .focus();
        recalculateMessageLength();
    }

    $dialog.find("button.primary").on("click", (e) => {
        const $commitMessage = getCommitMessageElement();
        if ($commitMessage.val().trim().length === 0) {
            e.stopPropagation();
            $commitMessage.addClass("invalid");
        } else {
            $commitMessage.removeClass("invalid");
        }
    });

    $dialog.find("button.extendedCommit").on("click", () => {
        switchCommitMessageElement();
        // this value will be set only when manually triggered
        Preferences.set("useTextAreaForCommitByDefault", usingTextArea);
    });

    function prefillMessage(msg) {
        if (msg.indexOf("\n") !== -1 && !usingTextArea) {
            switchCommitMessageElement();
        }
        $dialog.find("[name='commit-message']:visible").val(msg);
        recalculateMessageLength();
    }

    // Assign action to amend checkbox
    $dialog.find(".amend-commit").on("click", function () {
        if ($(this).prop("checked") === false) {
            prefillMessage("");
        } else {
            Git.getLastCommitMessage().then((msg) => prefillMessage(msg));
        }
    });

    if (Preferences.get("useTextAreaForCommitByDefault")) {
        switchCommitMessageElement();
    }

    if (prefilledMessage) {
        prefillMessage(prefilledMessage.trim());
    }

    // Add focus to commit message input
    getCommitMessageElement().focus();

    $dialog.find("[name='commit-message']")
        .on("keyup", recalculateMessageLength)
        .on("change", recalculateMessageLength);
    recalculateMessageLength();

    dialog.done((buttonId) => {
        if (buttonId === "ok") {
            if (commitMode === COMMIT_MODE.ALL || commitMode === COMMIT_MODE.CURRENT) {
                const filePaths = _.map(files, (next) => next.file);
                Git.stage(filePaths)
                    .then(() => _getStagedDiff())
                    .then((diff) => _doGitCommit($dialog, getCommitMessageElement, diff))
                    .catch((err) => ErrorHandler.showError(err, "Cant get diff for staged files"));
            } else {
                _doGitCommit($dialog, getCommitMessageElement, stagedDiff);
            }
        } else {
            Git.status();
        }
    });
}

function _doGitCommit($dialog, getCommitMessageElement, stagedDiff) {
    // this event won't launch when commit-message is empty so its safe to assume that it is not
    let commitMessage = getCommitMessageElement().val();
    const amendCommit = $dialog.find(".amend-commit").prop("checked");

    // if commit message is extended and has a newline, put an empty line after first line to separate subject and body
    const s = commitMessage.split("\n");
    if (s.length > 1 && s[1].trim() !== "") {
        s.splice(1, 0, "");
    }
    commitMessage = s.join("\n");

    // save lastCommitMessage in case the commit will fail
    lastCommitMessage = commitMessage;

    // now we are going to be paranoid and we will check if some mofo didn't change our diff
    _getStagedDiff().then((diff) => {
        if (diff === stagedDiff) {
            return Git.commit(commitMessage, amendCommit).then(() => {
                // clear lastCommitMessage because the commit was successful
                lastCommitMessage = null;
            });
        }
        throw new ExpectedError(
            "The files you were going to commit were modified while commit dialog was displayed. " +
            "Aborting the commit as the result would be different then what was shown in the dialog."
        );
    }).catch((err) => {
        if (ErrorHandler.contains(err, "Please tell me who you are")) {
            const defer = Promise.defer();
            EventEmitter.emit(Events.GIT_CHANGE_USERNAME, null, () => {
                EventEmitter.emit(Events.GIT_CHANGE_EMAIL, null, () => {
                    defer.resolve();
                });
            });
            return defer.promise;
        }
        return ErrorHandler.showError(err, "Git Commit failed");
    }).finally(() => {
        EventEmitter.emit(Events.GIT_COMMITED);
        refresh();
    });
}

function _showAuthors(file, blame, fromLine?, toLine?) {
    const linesTotal = blame.length;
    let blameStats = blame.reduce((stats, lineInfo) => {
        const name = lineInfo.author + " " + lineInfo["author-mail"];
        if (stats[name]) {
            stats[name] += 1;
        } else {
            stats[name] = 1;
        }
        return stats;
    }, {});
    blameStats = _.reduce(blameStats, (arr, val, key) => {
        arr.push({
            authorName: key,
            lines: val,
            percentage: Math.round(val / (linesTotal / 100))
        });
        return arr;
    }, []);
    blameStats = _.sortBy(blameStats, "lines").reverse();

    if (fromLine || toLine) {
        file += " (" + Strings.LINES + " " + fromLine + "-" + toLine + ")";
    }

    const compiledTemplate = Mustache.render(gitAuthorsDialogTemplate, { file, blameStats, Strings });
    Dialogs.showModalDialogUsingTemplate(compiledTemplate);
}

function _getCurrentFilePath(editor?) {
    const gitRoot = Preferences.get("currentGitRoot");
    const document = editor ? editor.document : DocumentManager.getCurrentDocument();
    let filePath = document.file.fullPath;
    if (filePath.indexOf(gitRoot) === 0) {
        filePath = filePath.substring(gitRoot.length);
    }
    return filePath;
}

function handleAuthorsSelection() {
    const editor = EditorManager.getActiveEditor();
    const filePath = _getCurrentFilePath(editor);
    const currentSelection = editor.getSelection();
    const fromLine = currentSelection.start.line + 1;
    let toLine = currentSelection.end.line + 1;

    // fix when nothing is selected on that line
    if (currentSelection.end.ch === 0) { toLine -= 1; }

    const isSomethingSelected = currentSelection.start.line !== currentSelection.end.line ||
                              currentSelection.start.ch !== currentSelection.end.ch;
    if (!isSomethingSelected) {
        ErrorHandler.showError(new ExpectedError(Strings.ERROR_NOTHING_SELECTED));
        return;
    }

    if (editor.document.isDirty) {
        ErrorHandler.showError(new ExpectedError(Strings.ERROR_SAVE_FIRST));
        return;
    }

    Git.getBlame(filePath, fromLine, toLine).then((blame) => {
        return _showAuthors(filePath, blame, fromLine, toLine);
    }).catch((err) => {
        ErrorHandler.showError(err, "Git Blame failed");
    });
}

function handleAuthorsFile() {
    const filePath = _getCurrentFilePath();
    Git.getBlame(filePath).then((blame) => {
        return _showAuthors(filePath, blame);
    }).catch((err) => {
        ErrorHandler.showError(err, "Git Blame failed");
    });
}

function handleGitDiff(file) {
    if (Preferences.get("useDifftool")) {
        Git.difftool(file);
    } else {
        Git.diffFileNice(file).then((diff) => {
            // show the dialog with the diff
            const compiledTemplate = Mustache.render(gitDiffDialogTemplate, { file, Strings });
            const dialog = Dialogs.showModalDialogUsingTemplate(compiledTemplate);
            const $dialog = dialog.getElement();
            _makeDialogBig($dialog);
            $dialog.find(".commit-diff").append(Utils.formatDiff(diff));
        }).catch((err) => {
            ErrorHandler.showError(err, "Git Diff failed");
        });
    }
}

function handleGitTag(file) {
    // Open the Tag Dialog
    const compiledTemplate = Mustache.render(gitTagDialogTemplate, { file, Strings });
    const dialog = Dialogs.showModalDialogUsingTemplate(compiledTemplate);
    const $dialog = dialog.getElement();
    _makeDialogBig($dialog);

    $dialog.find("button.primary").on("click", () => {
        const tagname = $dialog.find("input.commit-message").val();
        Git.setTagName(tagname).then(() => {
            refresh();
            EventEmitter.emit(Events.HISTORY_SHOW, "GLOBAL");
        }).catch((err) => {
            ErrorHandler.showError(err, "Create tag failed");
        });
    });
}

function handleGitUndo(file) {
    const compiledTemplate = Mustache.render(questionDialogTemplate, {
        title: Strings.UNDO_CHANGES,
        question: StringUtils.format(Strings.Q_UNDO_CHANGES, _.escape(file)),
        Strings
    });
    Dialogs.showModalDialogUsingTemplate(compiledTemplate).done((buttonId) => {
        if (buttonId === "ok") {
            Git2.discardFileChanges(file).then(() => {
                const gitRoot = Preferences.get("currentGitRoot");
                DocumentManager.getAllOpenDocuments().forEach((doc) => {
                    if (doc.file.fullPath === gitRoot + file) {
                        Utils.reloadDoc(doc);
                    }
                });
                refresh();
            }).catch((err) => {
                ErrorHandler.showError(err, "Discard changes to a file failed");
            });
        }
    });
}

function handleGitDelete(file) {
    const compiledTemplate = Mustache.render(questionDialogTemplate, {
        title: Strings.DELETE_FILE,
        question: StringUtils.format(Strings.Q_DELETE_FILE, _.escape(file)),
        Strings
    });
    Dialogs.showModalDialogUsingTemplate(compiledTemplate).done((buttonId) => {
        if (buttonId === "ok") {
            FileSystem.resolve(Preferences.get("currentGitRoot") + file, (err, fileEntry) => {
                if (err) {
                    ErrorHandler.showError(err, "Could not resolve file");
                    return;
                }
                Promise.cast(ProjectManager.deleteItem(fileEntry))
                    .then(() => {
                        refresh();
                    })
                    .catch((err2) => {
                        ErrorHandler.showError(err2, "File deletion failed");
                    });
            });
        }
    });
}

function _getStagedDiff(commitMode?, files?) {
    return ProgressDialog.show(_getStagedDiffForCommitMode(commitMode, files),
        Strings.GETTING_STAGED_DIFF_PROGRESS,
        { preDelay: 3, postDelay: 1 })
        .catch((err) => {
            if (ErrorHandler.contains(err, "cleanup")) {
                return false; // will display list of staged files instead
            }
            throw err;
        })
        .then((diff) => {
            if (!diff) {
                return Git.getListOfStagedFiles().then((filesList) => {
                    return Strings.DIFF_FAILED_SEE_FILES + "\n\n" + filesList;
                });
            }
            return diff;
        });
}

function _getStagedDiffForCommitMode(commitMode, files) {

    if (commitMode === COMMIT_MODE.ALL) {
        return _getStaggedDiffForAllFiles();
    }

    if (commitMode === COMMIT_MODE.CURRENT && _.isArray(files)) {
        if (files.length > 1) {
            return Promise.reject("_getStagedDiffForCommitMode() got files.length > 1");
        }

        const isUntracked = files[0].status.indexOf(Git.FILE_STATUS.UNTRACKED) !== -1;
        return isUntracked ?
            _getDiffForUntrackedFiles(files[0].file) :
            Git.getDiffOfAllIndexFiles(files[0].file);
    }

    return Git.getDiffOfStagedFiles();
}

function _getStaggedDiffForAllFiles() {
    return Git.status().then((statusFiles) => {
        const untrackedFiles = [];
        const fileArray = [];

        statusFiles.forEach((fileObject) => {
            const isUntracked = fileObject.status.indexOf(Git.FILE_STATUS.UNTRACKED) !== -1;
            if (isUntracked) {
                untrackedFiles.push(fileObject.file);
            } else {
                fileArray.push(fileObject.file);
            }
        });

        return untrackedFiles.length > 0 ?
            _getDiffForUntrackedFiles(fileArray.concat(untrackedFiles)) :
            Git.getDiffOfAllIndexFiles(fileArray);
    });
}

function _getDiffForUntrackedFiles(files) {
    let diff;
    return Git.stage(files, false)
        .then(() => Git.getDiffOfStagedFiles())
        .then((_diff) => {
            diff = _diff;
            return Git2.resetIndex();
        })
        .then(() => diff);
}

// whatToDo gets values "continue" "skip" "abort"
function handleRebase(whatToDo) {
    Git.rebase(whatToDo).then(() => {
        EventEmitter.emit(Events.REFRESH_ALL);
    }).catch((err) => {
        ErrorHandler.showError(err, "Rebase " + whatToDo + " failed");
    });
}

function abortMerge() {
    Git2.discardAllChanges().then(() => {
        EventEmitter.emit(Events.REFRESH_ALL);
    }).catch((err) => {
        ErrorHandler.showError(err, "Merge abort failed");
    });
}

function findConflicts() {
    FindInFiles.doSearch(/^<<<<<<<\s|^=======\s|^>>>>>>>\s/gm);
}

function commitMerge() {
    Utils.loadPathContent(Preferences.get("currentGitRoot") + "/.git/MERGE_MSG").then((msg) => {
        handleGitCommit(msg, true, COMMIT_MODE.DEFAULT);
        EventEmitter.once(Events.GIT_COMMITED, () => {
            EventEmitter.emit(Events.REFRESH_ALL);
        });
    }).catch((err) => {
        ErrorHandler.showError(err, "Merge commit failed");
    });
}

function inspectFiles(gitStatusResults) {
    const lintResults = [];

    const codeInspectionPromises = gitStatusResults.map((fileObj) => {
        const isDeleted = fileObj.status.indexOf(Git.FILE_STATUS.DELETED) !== -1;

        // do a code inspection for the file, if it was not deleted
        if (!isDeleted) {
            return lintFile(fileObj.file)
                .catch(() => {
                    return [
                        {
                            provider: { name: "See console [F12] for details" },
                            result: {
                                errors: [
                                    {
                                        pos: { line: 0, ch: 0 },
                                        message: "CodeInspection failed to execute for this file."
                                    }
                                ]
                            }
                        }
                    ];
                })
                .then((result) => {
                    if (result) {
                        lintResults.push({ filename: fileObj.file, result });
                    }
                });
        }
        return null;
    });

    return Promise.all(_.compact(codeInspectionPromises)).then(() => {
        return lintResults;
    });
}

function handleGitCommit(prefilledMessage, isMerge, commitMode) {

    const stripWhitespace = Preferences.get("stripWhitespaceFromCommits");
    const codeInspectionEnabled = Preferences.get("useCodeInspection");

    // Disable button (it will be enabled when selecting files after reset)
    Utils.setLoading($gitPanel.find(".git-commit"));

    let p;

    // First reset staged files, then add selected files to the index.
    if (commitMode === COMMIT_MODE.DEFAULT) {
        p = Git.status().then((files) => {
            files = _.filter(files, (file) => {
                return file.status.indexOf(Git.FILE_STATUS.STAGED) !== -1;
            });

            if (files.length === 0 && !isMerge) {
                return ErrorHandler.showError(
                    new Error("Commit button should have been disabled"),
                    "Nothing staged to commit"
                );
            }

            return handleGitCommitInternal(stripWhitespace,
                files,
                codeInspectionEnabled,
                commitMode,
                prefilledMessage);
        });
    } else if (commitMode === COMMIT_MODE.ALL) {
        p = Git.status().then((files) => {
            return handleGitCommitInternal(stripWhitespace,
                files,
                codeInspectionEnabled,
                commitMode,
                prefilledMessage);
        });
    } else if (commitMode === COMMIT_MODE.CURRENT) {
        p = Git.status().then((files) => {
            const gitRoot = Preferences.get("currentGitRoot");
            const currentDoc = DocumentManager.getCurrentDocument();
            if (currentDoc) {
                const relativePath = currentDoc.file.fullPath.substring(gitRoot.length);
                const currentFile = _.filter(files, (next) => {
                    return relativePath === next.file;
                });
                return handleGitCommitInternal(
                    stripWhitespace, currentFile, codeInspectionEnabled, commitMode, prefilledMessage
                );
            }
            return null;
        });
    }

    p.catch((err) => {
        ErrorHandler.showError(err, "Preparing commit dialog failed");
    }).finally(() => {
        Utils.unsetLoading($gitPanel.find(".git-commit"));
    });

}

function handleGitCommitInternal(stripWhitespace, files, codeInspectionEnabled, commitMode, prefilledMessage) {
    let queue: Promise<any> = Promise.resolve();
    let lintResults;

    if (stripWhitespace) {
        queue = queue.then(() => {
            return ProgressDialog.show(Utils.stripWhitespaceFromFiles(files, commitMode === COMMIT_MODE.DEFAULT),
                Strings.CLEANING_WHITESPACE_PROGRESS,
                { preDelay: 3, postDelay: 1 });
        });
    }

    if (codeInspectionEnabled) {
        queue = queue.then(() => {
            return inspectFiles(files).then((_lintResults) => {
                lintResults = _lintResults;
            });
        });
    }

    return queue.then(() => {
        // All files are in the index now, get the diff and show dialog.
        return _getStagedDiff(commitMode, files).then((diff) => {
            return _showCommitDialog(diff, lintResults, prefilledMessage, commitMode, files);
        });
    });
}

function refreshCurrentFile() {
    const gitRoot = Preferences.get("currentGitRoot");
    const currentDoc = DocumentManager.getCurrentDocument();
    if (currentDoc) {
        $gitPanel.find("tr").each(function () {
            const currentFullPath = currentDoc.file.fullPath;
            const thisFile = $(this).attr("x-file");
            $(this).toggleClass("selected", gitRoot + thisFile === currentFullPath);
        });
    } else {
        $gitPanel.find("tr").removeClass("selected");
    }
}

function shouldShow(fileObj) {
    if (showFileWhiteList.test(fileObj.name)) {
        return true;
    }
    return ProjectManager.shouldShow(fileObj);
}

function _refreshTableContainer(files) {
    if (!gitPanel.isVisible()) {
        return;
    }

    // remove files that we should not show
    files = _.filter(files, (file) => {
        return shouldShow(file);
    });

    const allStaged = files.length > 0 && _.all(files, (file) => {
        return file.status.indexOf(Git.FILE_STATUS.STAGED) !== -1;
    });
    $gitPanel.find(".check-all").prop("checked", allStaged).prop("disabled", files.length === 0);

    const $editedList = $tableContainer.find(".git-edited-list");
    const visibleBefore = $editedList.length ? $editedList.is(":visible") : true;
    $editedList.remove();

    if (files.length === 0) {
        $tableContainer.append($("<p class='git-edited-list nothing-to-commit' />").text(Strings.NOTHING_TO_COMMIT));
    } else {
        // if desired, remove untracked files from the results
        if (showingUntracked === false) {
            files = _.filter(files, (file) => {
                return file.status.indexOf(Git.FILE_STATUS.UNTRACKED) === -1;
            });
        }
        // -
        files.forEach((file) => {
            file.staged = file.status.indexOf(Git.FILE_STATUS.STAGED) !== -1;
            file.statusText = file.status.map((status) => {
                return Strings["FILE_" + status];
            }).join(", ");
            file.allowDiff = file.status.indexOf(Git.FILE_STATUS.UNTRACKED) === -1 &&
                             file.status.indexOf(Git.FILE_STATUS.RENAMED) === -1 &&
                             file.status.indexOf(Git.FILE_STATUS.DELETED) === -1;
            file.allowDelete = file.status.indexOf(Git.FILE_STATUS.UNTRACKED) !== -1 ||
                               file.status.indexOf(Git.FILE_STATUS.STAGED) !== -1 &&
                               file.status.indexOf(Git.FILE_STATUS.ADDED) !== -1;
            file.allowUndo = !file.allowDelete;
        });
        $tableContainer.append(Mustache.render(gitPanelResultsTemplate, { files, Strings }));

        refreshCurrentFile();
    }
    $tableContainer.find(".git-edited-list").toggle(visibleBefore);
}

function refreshCommitCounts() {
    // Find Push and Pull buttons
    const $pullBtn = $gitPanel.find(".git-pull");
    const $pushBtn = $gitPanel.find(".git-push");
    const clearCounts = function () {
        $pullBtn.children("span").remove();
        $pushBtn.children("span").remove();
    };

    // Check if there's a remote, resolve if there's not
    const remotes = Preferences.get("defaultRemotes") || {};
    const defaultRemote = remotes[Preferences.get("currentGitRoot")];
    if (!defaultRemote) {
        clearCounts();
        return Promise.resolve();
    }

    // Get the commit counts and append them to the buttons
    return Git.getCommitCounts().then((commits) => {
        clearCounts();
        if (commits.behind > 0) {
            $pullBtn.append($("<span/>").text(" (" + commits.behind + ")"));
        }
        if (commits.ahead > 0) {
            $pushBtn.append($("<span/>").text(" (" + commits.ahead + ")"));
        }
    }).catch((err) => {
        clearCounts();
        ErrorHandler.logError(err);
    });
}

export function refresh() {
    // set the history panel to false and remove the class that show the button history active when refresh
    $gitPanel.find(".git-history-toggle").removeClass("active").attr("title", Strings.TOOLTIP_SHOW_HISTORY);
    $gitPanel.find(".git-file-history").removeClass("active").attr("title", Strings.TOOLTIP_SHOW_FILE_HISTORY);

    if (gitPanelMode === "not-repo") {
        $tableContainer.empty();
        return Promise.resolve();
    }

    $tableContainer.find("#git-history-list").remove();
    $tableContainer.find(".git-edited-list").show();

    const p1 = Git.status().catch((err) => {
        // this is an expected "error"
        if (ErrorHandler.contains(err, "Not a git repository")) {
            return;
        }
        throw err;
    });

    const p2 = refreshCommitCounts();

    // Clone button
    $gitPanel.find(".git-clone").prop("disabled", false);

    // FUTURE: who listens for this?
    return Promise.all([p1, p2]);
}

export function toggle(bool) {
    if (gitPanelDisabled === true) {
        return;
    }
    if (typeof bool !== "boolean") {
        bool = !gitPanel.isVisible();
    }
    Preferences.persist("panelEnabled", bool);
    Main.$icon.toggleClass("on", bool);
    gitPanel.setVisible(bool);

    // Mark menu item as enabled/disabled.
    CommandManager.get(PANEL_COMMAND_ID).setChecked(bool);

    if (bool) {
        refresh();
    }
}

function handleToggleUntracked() {
    showingUntracked = !showingUntracked;

    $gitPanel
        .find(".git-toggle-untracked")
        .text(showingUntracked ? Strings.HIDE_UNTRACKED : Strings.SHOW_UNTRACKED);

    refresh();
}

function commitCurrentFile() {
    // do not return anything here, core expects jquery promise
    Promise.cast(CommandManager.execute("file.save"))
        .then(() => {
            return Git2.resetIndex();
        })
        .then(() => {
            return handleGitCommit(lastCommitMessage, false, COMMIT_MODE.CURRENT);
        });
}

function commitAllFiles() {
    // do not return anything here, core expects jquery promise
    Promise.cast(CommandManager.execute("file.saveAll"))
        .then(() => {
            return Git2.resetIndex();
        })
        .then(() => {
            return handleGitCommit(lastCommitMessage, false, COMMIT_MODE.ALL);
        });
}

// Disable "commit" button if there aren't staged files to commit
function _toggleCommitButton(files) {
    const anyStaged = _.any(files, (file) => file.status.indexOf(Git.FILE_STATUS.STAGED) !== -1);
    $gitPanel.find(".git-commit").prop("disabled", !anyStaged);
}

EventEmitter.on(Events.GIT_STATUS_RESULTS, (results) => {
    _refreshTableContainer(results);
    _toggleCommitButton(results);
});

function undoLastLocalCommit() {
    Git2.undoLastLocalCommit()
        .catch((err) => {
            ErrorHandler.showError(err, "Impossible to undo last commit");
        })
        .finally(() => {
            refresh();
        });
}

let lastCheckOneClicked = null;

function attachDefaultTableHandlers() {
    $tableContainer = $gitPanel.find(".table-container")
        .off()
        .on("click", ".check-one", function (e) {
            e.stopPropagation();
            const $tr = $(this).closest("tr");
            const file = $tr.attr("x-file");
            const status = $tr.attr("x-status");
            const isChecked = $(this).is(":checked");

            if (e.shiftKey) {
                // stage/unstage all file between
                const lc = lastCheckOneClicked.localeCompare(file);
                const lcClickedSelector = "[x-file='" + lastCheckOneClicked + "']";
                let sequence;

                if (lc < 0) {
                    sequence = $tr.prevUntil(lcClickedSelector).andSelf();
                } else if (lc > 0) {
                    sequence = $tr.nextUntil(lcClickedSelector).andSelf();
                }

                if (sequence) {
                    sequence = sequence.add($tr.parent().children(lcClickedSelector));
                    const promises = sequence.map(function () {
                        const $this = $(this);
                        return isChecked ?
                            Git.stage($this.attr("x-file"), $this.attr("x-status") === Git.FILE_STATUS.DELETED) :
                            Git.unstage($this.attr("x-file"));
                    }).toArray();
                    return Promise.all(promises).then(() => {
                        return Git.status();
                    }).catch((err) => {
                        ErrorHandler.showError(err, "Modifying file status failed");
                    });
                }
            }

            lastCheckOneClicked = file;

            if (isChecked) {
                return Git.stage(file, status === Git.FILE_STATUS.DELETED).then(() => {
                    Git.status();
                });
            }
            return Git.unstage(file).then(() => {
                Git.status();
            });
        })
        .on("dblclick", ".check-one", (e) => {
            e.stopPropagation();
        })
        .on("click", ".btn-git-diff", (e) => {
            e.stopPropagation();
            handleGitDiff($(e.target).closest("tr").attr("x-file"));
        })
        .on("click", ".btn-git-undo", (e) => {
            e.stopPropagation();
            handleGitUndo($(e.target).closest("tr").attr("x-file"));
        })
        .on("click", ".btn-git-delete", (e) => {
            e.stopPropagation();
            handleGitDelete($(e.target).closest("tr").attr("x-file"));
        })
        .on("click", ".modified-file", (e) => {
            const $this = $(e.currentTarget);
            if ($this.attr("x-status") === Git.FILE_STATUS.DELETED) {
                return;
            }
            CommandManager.execute(Commands.FILE_OPEN, {
                fullPath: Preferences.get("currentGitRoot") + $this.attr("x-file")
            });
        })
        .on("dblclick", ".modified-file", (e) => {
            const $this = $(e.currentTarget);
            if ($this.attr("x-status") === Git.FILE_STATUS.DELETED) {
                return;
            }
            FileViewController.addToWorkingSetAndSelect(Preferences.get("currentGitRoot") + $this.attr("x-file"));
        });

}

EventEmitter.on(Events.GIT_CHANGE_USERNAME, (event, callback) => {
    return Git.getConfig("user.name").then((currentUserName) => {
        return Utils.askQuestion(
            Strings.CHANGE_USER_NAME, Strings.ENTER_NEW_USER_NAME, { defaultValue: currentUserName }
        )
            .then((userName: string) => {
                if (!userName.length) { userName = currentUserName; }
                return Git.setConfig("user.name", userName, true).catch((err) => {
                    ErrorHandler.showError(err, "Impossible to change username");
                }).then(() => {
                    EventEmitter.emit(Events.GIT_USERNAME_CHANGED, userName);
                }).finally(() => {
                    if (callback) {
                        return callback(userName);
                    }
                });
            });
    });
});

EventEmitter.on(Events.GIT_CHANGE_EMAIL, (event, callback) => {
    return Git.getConfig("user.email").then((currentUserEmail) => {
        return Utils.askQuestion(
            Strings.CHANGE_USER_EMAIL, Strings.ENTER_NEW_USER_EMAIL, { defaultValue: currentUserEmail }
        )
            .then((userEmail: string) => {
                if (!userEmail.length) { userEmail = currentUserEmail; }
                return Git.setConfig("user.email", userEmail, true).catch((err) => {
                    ErrorHandler.showError(err, "Impossible to change user email");
                }).then(() => {
                    EventEmitter.emit(Events.GIT_EMAIL_CHANGED, userEmail);
                }).finally(() => {
                    if (callback) {
                        return callback(userEmail);
                    }
                });
            });
    });
});

EventEmitter.on(Events.GERRIT_TOGGLE_PUSH_REF, (event, callback) => {
    // update preference and emit so the menu item updates
    return Git.getConfig("gerrit.pushref").then((strEnabled) => {
        const toggledValue = strEnabled !== "true";

        // Set the global preference
        // Saving a preference to tell the GitCli.push() method to check for gerrit push ref enablement
        // so we don't slow down people who aren't using gerrit.
        Preferences.persist("gerritPushref", toggledValue);

        return Git.setConfig("gerrit.pushref", toggledValue, true)
            .then(() => {
                EventEmitter.emit(Events.GERRIT_PUSH_REF_TOGGLED, toggledValue);
            })
            .finally(() => {
                if (callback) {
                    return callback(toggledValue);
                }
            });
    }).catch((err) => {
        ErrorHandler.showError(err, "Impossible to toggle gerrit push ref");
    });
});

EventEmitter.on(Events.GERRIT_PUSH_REF_TOGGLED, (enabled) => {
    setGerritCheckState(enabled);
});

function setGerritCheckState(enabled) {
    $gitPanel
        .find(".toggle-gerrit-push-ref")
        .toggleClass("checkmark", enabled);
}

function discardAllChanges() {
    return Utils.askQuestion(Strings.RESET_LOCAL_REPO, Strings.RESET_LOCAL_REPO_CONFIRM, { booleanResponse: true })
        .then((response) => {
            if (response) {
                return Git2.discardAllChanges().catch((err) => {
                    ErrorHandler.showError(err, "Reset of local repository failed");
                }).then(() => {
                    refresh();
                });
            }
            return null;
        });
}

export function init() {
    // Add panel
    const panelHtml = Mustache.render(gitPanelTemplate, {
        enableAdvancedFeatures: Preferences.get("enableAdvancedFeatures"),
        showBashButton: Preferences.get("showBashButton"),
        S: Strings
    });
    const $panelHtml = $(panelHtml);
    $panelHtml.find(".git-available, .git-not-available").hide();

    gitPanel = WorkspaceManager.createBottomPanel("quadre-git.panel", $panelHtml, 100);
    $gitPanel = gitPanel.$panel;

    $gitPanel
        .on("click", ".close", toggle)
        .on("click", ".check-all", function () {
            return $(this).is(":checked") ?
                Git.stageAll().then(() => {
                    Git.status();
                }) :
                Git2.resetIndex().then(() => {
                    Git.status();
                });
        })
        .on("click", ".git-refresh", EventEmitter.emitFactory(Events.REFRESH_ALL))
        .on("click", ".git-commit", EventEmitter.emitFactory(Events.HANDLE_GIT_COMMIT))
        .on("click", ".git-rebase-continue", (e) => { handleRebase("continue"); })
        .on("click", ".git-rebase-skip", (e) => { handleRebase("skip"); })
        .on("click", ".git-rebase-abort", (e) => { handleRebase("abort"); })
        .on("click", ".git-commit-merge", commitMerge)
        .on("click", ".git-merge-abort", abortMerge)
        .on("click", ".git-find-conflicts", findConflicts)
        .on("click", ".git-prev-gutter", GutterManager.goToPrev)
        .on("click", ".git-next-gutter", GutterManager.goToNext)
        .on("click", ".git-toggle-untracked", handleToggleUntracked)
        .on("click", ".authors-selection", handleAuthorsSelection)
        .on("click", ".authors-file", handleAuthorsFile)
        .on("click", ".git-file-history", EventEmitter.emitFactory(Events.HISTORY_SHOW, "FILE"))
        .on("click", ".git-history-toggle", EventEmitter.emitFactory(Events.HISTORY_SHOW, "GLOBAL"))
        .on("click", ".git-fetch", EventEmitter.emitFactory(Events.HANDLE_FETCH))
        .on("click", ".git-push", function () {
            const typeOfRemote = $(this).attr("x-selected-remote-type");
            if (typeOfRemote === "git") {
                EventEmitter.emit(Events.HANDLE_PUSH);
            }
        })
        .on("click", ".git-pull", EventEmitter.emitFactory(Events.HANDLE_PULL))
        .on("click", ".git-bug", ErrorHandler.reportBug)
        .on("click", ".git-init", EventEmitter.emitFactory(Events.HANDLE_GIT_INIT))
        .on("click", ".git-clone", EventEmitter.emitFactory(Events.HANDLE_GIT_CLONE))
        .on("click", ".change-remote", EventEmitter.emitFactory(Events.HANDLE_REMOTE_PICK))
        .on("click", ".remove-remote", EventEmitter.emitFactory(Events.HANDLE_REMOTE_DELETE))
        .on("click", ".git-remote-new", EventEmitter.emitFactory(Events.HANDLE_REMOTE_CREATE))
        .on("click", ".git-settings", SettingsDialog.show)
        .on("contextmenu", "tr", function (e) {
            const $this = $(this);
            if ($this.hasClass("history-commit")) { return; }

            $this.click();
            setTimeout(() => {
                Menus.getContextMenu("git-panel-context-menu").open(e);
            }, 1);
        })
        .on("click", ".change-user-name", EventEmitter.emitFactory(Events.GIT_CHANGE_USERNAME))
        .on("click", ".change-user-email", EventEmitter.emitFactory(Events.GIT_CHANGE_EMAIL))
        .on("click", ".toggle-gerrit-push-ref", EventEmitter.emitFactory(Events.GERRIT_TOGGLE_PUSH_REF))
        .on("click", ".undo-last-commit", undoLastLocalCommit)
        .on("click", ".git-bash", EventEmitter.emitFactory(Events.TERMINAL_OPEN))
        .on("click", ".tags", (e) => {
            e.stopPropagation();
            handleGitTag($(e.target).closest("tr").attr("x-file"));
        })
        .on("click", ".reset-all", discardAllChanges);

    /* Put here event handlers for advanced actions
    if (Preferences.get("enableAdvancedFeatures")) {

        $gitPanel
            .on("click", target, function);

     }
     */

    // Attaching table handlers
    attachDefaultTableHandlers();

    // Commit current and all shortcuts
    const COMMIT_CURRENT_CMD = "quadre-git.commitCurrent";
    const COMMIT_ALL_CMD = "quadre-git.commitAll";
    const BASH_CMD = "quadre-git.launchBash";
    const PUSH_CMD = "quadre-git.push";
    const PULL_CMD = "quadre-git.pull";
    const GOTO_PREV_CHANGE = "quadre-git.gotoPrevChange";
    const GOTO_NEXT_CHANGE = "quadre-git.gotoNextChange";
    const REFRESH_GIT = "quadre-git.refreshAll";

    // Add command to menu.
    // Register command for opening bottom panel.
    CommandManager.register(Strings.PANEL_COMMAND, PANEL_COMMAND_ID, toggle);
    KeyBindingManager.addBinding(PANEL_COMMAND_ID, Preferences.get("panelShortcut"), brackets.platform);

    CommandManager.register(Strings.COMMIT_CURRENT_SHORTCUT, COMMIT_CURRENT_CMD, commitCurrentFile);
    KeyBindingManager.addBinding(COMMIT_CURRENT_CMD, Preferences.get("commitCurrentShortcut"), brackets.platform);

    CommandManager.register(Strings.COMMIT_ALL_SHORTCUT, COMMIT_ALL_CMD, commitAllFiles);
    KeyBindingManager.addBinding(COMMIT_ALL_CMD, Preferences.get("commitAllShortcut"), brackets.platform);

    CommandManager.register(Strings.LAUNCH_BASH_SHORTCUT, BASH_CMD, EventEmitter.emitFactory(Events.TERMINAL_OPEN));
    KeyBindingManager.addBinding(BASH_CMD, Preferences.get("bashShortcut"), brackets.platform);

    CommandManager.register(Strings.PUSH_SHORTCUT, PUSH_CMD, EventEmitter.emitFactory(Events.HANDLE_PUSH));
    KeyBindingManager.addBinding(PUSH_CMD, Preferences.get("pushShortcut"), brackets.platform);

    CommandManager.register(Strings.PULL_SHORTCUT, PULL_CMD, EventEmitter.emitFactory(Events.HANDLE_PULL));
    KeyBindingManager.addBinding(PULL_CMD, Preferences.get("pullShortcut"), brackets.platform);

    CommandManager.register(Strings.GOTO_PREVIOUS_GIT_CHANGE, GOTO_PREV_CHANGE, GutterManager.goToPrev);
    KeyBindingManager.addBinding(GOTO_PREV_CHANGE, Preferences.get("gotoPrevChangeShortcut"), brackets.platform);

    CommandManager.register(Strings.GOTO_NEXT_GIT_CHANGE, GOTO_NEXT_CHANGE, GutterManager.goToNext);
    KeyBindingManager.addBinding(GOTO_NEXT_CHANGE, Preferences.get("gotoNextChangeShortcut"), brackets.platform);

    CommandManager.register(Strings.REFRESH_GIT, REFRESH_GIT, EventEmitter.emitFactory(Events.REFRESH_ALL));
    KeyBindingManager.addBinding(REFRESH_GIT, Preferences.get("refreshShortcut"), brackets.platform);

    // Init moment - use the correct language
    moment.lang(brackets.getLocale());

    // Show gitPanel when appropriate
    if (Preferences.get("panelEnabled")) {
        toggle(true);
    }
} // function init() {

export function enable() {
    EventEmitter.emit(Events.GIT_ENABLED);
    // this function is called after every Branch.refresh
    gitPanelMode = null;
    //
    $gitPanel.find(".git-available").show();
    $gitPanel.find(".git-not-available").hide();
    //
    Main.$icon.removeClass("warning").removeAttr("title");
    gitPanelDisabled = false;
    // after all is enabled
    refresh();
}

export function disable(cause) {
    EventEmitter.emit(Events.GIT_DISABLED, cause);
    gitPanelMode = cause;
    // causes: not-repo
    if (gitPanelMode === "not-repo") {
        $gitPanel.find(".git-available").hide();
        $gitPanel.find(".git-not-available").show();
    } else {
        Main.$icon.addClass("warning").attr("title", cause);
        toggle(false);
        gitPanelDisabled = true;
    }
    refresh();
}

// Event listeners
EventEmitter.on(Events.GIT_USERNAME_CHANGED, (userName) => {
    $gitPanel.find(".git-user-name").text(userName);
});

EventEmitter.on(Events.GIT_EMAIL_CHANGED, (email) => {
    $gitPanel.find(".git-user-email").text(email);
});

EventEmitter.on(Events.GIT_REMOTE_AVAILABLE, () => {
    $gitPanel.find(".git-pull, .git-push, .git-fetch").prop("disabled", false);
});

EventEmitter.on(Events.GIT_REMOTE_NOT_AVAILABLE, () => {
    $gitPanel.find(".git-pull, .git-push, .git-fetch").prop("disabled", true);
});

EventEmitter.on(Events.GIT_ENABLED, () => {
    // Add info from Git to panel
    Git.getConfig("user.name").then((currentUserName) => {
        EventEmitter.emit(Events.GIT_USERNAME_CHANGED, currentUserName);
    });
    Git.getConfig("user.email").then((currentEmail) => {
        EventEmitter.emit(Events.GIT_EMAIL_CHANGED, currentEmail);
    });
    Git.getConfig("gerrit.pushref").then((strEnabled) => {
        const enabled = strEnabled === "true";
        // Handle the case where we switched to a repo that is using gerrit
        if (enabled && !Preferences.get("gerritPushref")) {
            Preferences.persist("gerritPushref", true);
        }
        EventEmitter.emit(Events.GERRIT_PUSH_REF_TOGGLED, enabled);
    });
});

EventEmitter.on(Events.BRACKETS_CURRENT_DOCUMENT_CHANGE, () => {
    if (!gitPanel) { return; }
    refreshCurrentFile();
});

EventEmitter.on(Events.BRACKETS_DOCUMENT_SAVED, () => {
    if (!gitPanel) { return; }
    refresh();
});

EventEmitter.on(Events.BRACKETS_FILE_CHANGED, (event, fileSystemEntry) => {
    // files are added or deleted from the directory
    if (fileSystemEntry.isDirectory) {
        refresh();
    }
});

EventEmitter.on(Events.REBASE_MERGE_MODE, (rebaseEnabled, mergeEnabled) => {
    $gitPanel.find(".git-rebase").toggle(rebaseEnabled);
    $gitPanel.find(".git-merge").toggle(mergeEnabled);
    $gitPanel.find("button.git-commit").toggle(!rebaseEnabled && !mergeEnabled);
});

EventEmitter.on(Events.FETCH_STARTED, () => {
    $gitPanel.find(".git-fetch")
        .addClass("btn-loading")
        .prop("disabled", true);
});

EventEmitter.on(Events.FETCH_COMPLETE, () => {
    $gitPanel.find(".git-fetch")
        .removeClass("btn-loading")
        .prop("disabled", false);
    refreshCommitCounts();
});

EventEmitter.on(Events.REFRESH_COUNTERS, () => {
    refreshCommitCounts();
});

EventEmitter.on(Events.HANDLE_GIT_COMMIT, () => {
    handleGitCommit(lastCommitMessage, false, COMMIT_MODE.DEFAULT);
});

EventEmitter.on(Events.TERMINAL_DISABLE, () => {
    $gitPanel.find(".git-bash").prop("disabled", true).attr("title", Strings.TERMINAL_DISABLED);
});

export function getPanel() { return $gitPanel; }
