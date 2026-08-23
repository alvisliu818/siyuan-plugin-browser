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

/** 下载项状态 */
export type DownloadState = "in_progress" | "completed" | "canceled" | "interrupted";

/** 下载项 */
export interface DownloadItem {
    id: string;
    url: string;
    filename: string;
    /** 保存路径（思源 assets 路径或插件 storage 相对路径） */
    savePath: string;
    total: number;
    received: number;
    state: DownloadState;
    startedAt: number;
    finishedAt?: number;
    /** 错误信息 */
    error?: string;
}

/** 默认搜索引擎 */
export interface SearchEngine {
    id: string;
    name: string;
    /** 搜索 URL 模板，使用 {q} 占位 */
    url: string;
}

/** 下载保存位置 */
export type DownloadTarget = "assets" | "storage";

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
    /** 下载保存位置 */
    downloadTarget: DownloadTarget;
    /** User-Agent 覆盖（空表示使用默认） */
    userAgent: string;
    /** 是否启用 webview preload 注入 */
    enablePreload: boolean;
    /** 摘录保存的笔记本 ID */
    excerptNotebook: string;
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
    downloadURL(url: string, options?: { filename?: string }): void;
    findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): void;
    stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
    openDevTools(): void;
    goBack(): void;
    goForward(): void;
    capturePage(): Promise<{ dataURL: string }>;
    addEventListener(type: string, listener: (e: any) => void, options?: any): void;
    removeEventListener(type: string, listener: (e: any) => void, options?: any): void;
}

/** 上下文菜单参数（webview context-menu 事件） */
export interface IContextMenuParams {
    x: number;
    y: number;
    linkURL: string;
    srcURL: string;
    pageURL: string;
    selectionText: string;
    mediaType: "none" | "image" | "audio" | "video" | "canvas" | "file" | "plugin";
    isEditable: boolean;
    editText?: string;
}
