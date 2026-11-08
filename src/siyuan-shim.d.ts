/**
 * siyuan 类型兼容垫片（仅作用于类型检查，不参与运行时）。
 *
 * 背景：siyuan@1.2.2 的 types/constants.ts 是 .ts 源文件（非 .d.ts），其中的
 * 常量对象缺少 IKeymapEditorGeneral 要求的 foldRecursive 字段（TS2741）。包的
 * types/index.d.ts 通过 `export * from "./constants"` 把它拉进编译 program，
 * 而 skipLibCheck 只跳过 .d.ts，无法跳过 .ts，因此 tsc --noEmit 会报一条无法
 * 通过项目源码修复的第三方错误。
 *
 * 这里由 tsconfig 的 paths 将 "siyuan" 解析到本声明文件，为项目实际用到的导出
 * 提供最小声明，避免把整个包的 .ts 源文件纳入类型检查。运行时仍由思源注入的
 * 真实 siyuan 模块提供（webpack 的模块解析不受 tsconfig paths 影响）。
 */
export const Plugin: any;
export type Plugin = any;
export const openTab: any;
export type openTab = any;
export const showMessage: any;
export type showMessage = any;
export const getActiveTab: any;
export type getActiveTab = any;
export const fetchSyncPost: any;
export type fetchSyncPost = any;
export const Setting: any;
export type Setting = any;
export const Menu: any;
export type Menu = any;
export const Dialog: any;
export type Dialog = any;
export const confirm: any;
export type confirm = any;
