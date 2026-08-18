/**
 * 内部类型定义
 */

/** 浏览器页签携带的数据 */
export interface IBrowserTabData {
    url: string;
    /** 是否在新页签中打开（保留扩展字段） */
    active?: boolean;
}

/** 书签 */
export interface Bookmark {
    id: string;
    title: string;
    url: string;
    favicon?: string;
    /** 标签列表（替代原来的文件夹层级） */
    tags: string[];
    createdAt: number;
    /** 排序 */
    order?: number;
}

/** 历史记录条目 */
export interface HistoryEntry {
    url: string;
    title: string;
    favicon?: string;
    visitTime: number;
}

/** 默认搜索引擎 */
export interface SearchEngine {
    id: string;
    name: string;
    /** 搜索 URL 模板，使用 {q} 占位 */
    url: string;
}

/** 插件设置 */
export interface BrowserSettings {
    /** 主页 URL */
    homepage: string;
    /** 默认搜索引擎 id */
    searchEngine: string;
    /** 自定义搜索引擎 URL（当 searchEngine === "custom" 时使用） */
    customSearchUrl: string;
    /** 历史记录上限 */
    historyLimit: number;
    /** 是否记录历史 */
    recordHistory: boolean;
    /** User-Agent 覆盖（空表示使用默认） */
    userAgent: string;
    /** 是否启用 webview preload 注入 */
    enablePreload: boolean;
    /** 所有 http(s) 链接都用浏览器插件打开（拦截全局点击） */
    interceptAllLinks: boolean;
    /** 排除网站列表（每行一个 hostname，匹配的 URL 在系统默认浏览器打开） */
    excludedSites: string;
}

/** webview 元素的扩展类型（Electron webview tag） */
export interface IWebviewTag extends HTMLElement {
    src: string;
    preload: string;
    allowpopups?: boolean;
    useragent?: string;
    disablewebsecurity?: boolean;
    loadURL(url: string, options?: { userAgent?: string }): Promise<void>;
    getURL(): string;
    getTitle(): string;
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    reload(): void;
    reloadIgnoringCache(): void;
    stop(): void;
    executeJavaScript(code: string, userGesture?: boolean): Promise<any>;
    findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): void;
    stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
    addEventListener(type: string, listener: (e: any) => void, options?: any): void;
    removeEventListener(type: string, listener: (e: any) => void, options?: any): void;
}
