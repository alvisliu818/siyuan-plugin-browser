// 通过 webpack asset/source 以字符串形式导入的注入脚本
declare module "*Readability.js" {
    const content: string;
    export default content;
}
declare module "*clipScript.js" {
    const content: string;
    export default content;
}
declare module "*annotationScript.js" {
    const content: string;
    export default content;
}
declare module "*adblock-rules.txt" {
    const content: string;
    export default content;
}
