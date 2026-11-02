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

/** 代理模式：跟随思源代理 / 系统代理 / 自定义代理 */
export type ProxyMode = "siyuan" | "system" | "custom";

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
    /** 代理模式（webview 独立 session，需显式 setProxy 才能吃到代理） */
    proxyMode: ProxyMode;
    /** 自定义代理地址（proxyMode === "custom" 时使用），如 http://127.0.0.1:7890、socks5://127.0.0.1:7891 */
    proxyCustomUrl: string;
    /** 是否启用 webview preload 注入 */
    enablePreload: boolean;
    /** 扩展面板 DevTools 调试开关（true=面板显示 DT 按钮且 F12 可开 DevTools） */
    popupDevtools: boolean;
    /** 摘录保存的笔记本 ID */
    excerptNotebook: string;
    /** 摘录保存路径（人类可读路径，默认根 "/"/，支持 {{...}} sprig 模板） */
    excerptParentPath: string;
    /** 摘录文档标签（逗号分隔） */
    excerptTags: string;
    /** 摘录时是否下载资源文件到思源 assets */
    excerptAssets: boolean;
    /** 摘录前处理：粗体样式转 <b> */
    excerptExpBold: boolean;
    /** 摘录前处理：斜体样式转 <i> */
    excerptExpItalic: boolean;
    /** 摘录前处理：下划线样式转 <u> */
    excerptExpUnderline: boolean;
    /** 摘录前处理：移除图片链接 */
    excerptExpRemoveImgLink: boolean;
    /** 摘录前处理：span 换行转 <br> */
    excerptExpSpan: boolean;
    /** 摘录前处理：内嵌 SVG 转图片 */
    excerptExpSvgToImg: boolean;
    /** 所有 http(s) 链接都用浏览器插件打开（拦截全局点击） */
    interceptAllLinks: boolean;
    /** 排除网站列表（每行一个 hostname，匹配的 URL 在系统默认浏览器打开） */
    excludedSites: string;
    /** 内置广告过滤（元素隐藏）开关 */
    adBlockEnabled: boolean;
    /** 用户自定义广告隐藏规则（adblock ## 语法，每行一条） */
    adBlockRules: string;
    /** 顶栏「Chrome 扩展」图标 */
    showExtIcon: boolean;
    /** 侧栏「书签」面板图标 */
    showBookmarksDock: boolean;
    /** 侧栏「历史」面板图标 */
    showHistoryDock: boolean;
    /** 底部「下载」面板图标 */
    showDownloadsDock: boolean;
    /** 新标签页扩展（扩展的 chrome_url_overrides.newtab 页作为新页签默认页；空 = 主页） */
    newTabExtId: string;
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
    insertCSS(css: string): Promise<string>;
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
