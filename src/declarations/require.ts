type RequireJSModuleDefinition = (require: any, exports: any, module: any) => void;
declare const define: (fn: RequireJSModuleDefinition) => void;

declare module "text!*" {
    let text: string;
    export default text;
}
