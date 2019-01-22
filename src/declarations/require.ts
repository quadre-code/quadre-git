type RequireJSModuleDefinition = (require: any, exports: any, module: any) => void;
declare const define: (fn: RequireJSModuleDefinition) => void;
