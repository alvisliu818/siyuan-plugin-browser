import type { BrowserSettings, ProxyMode, SearchEngine } from "./types";

/** Tab/Dock 类型常量 */
export const TAB_TYPE = "browser-tab";
export const DOCK_BOOKMARKS = "browser-bookmarks";
export const DOCK_HISTORY = "browser-history";
export const DOCK_DOWNLOADS = "browser-downloads";

/** Storage key */
export const STORAGE_KEYS = {
    bookmarks: "bookmarks.json",
    history: "history.json",
    downloads: "downloads.json",
    settings: "settings.json",
} as const;

/** 内置搜索引擎列表 */
export const SEARCH_ENGINES: SearchEngine[] = [
    { id: "google", name: "Google", url: "https://www.google.com/search?q={q}" },
    { id: "bing", name: "Bing", url: "https://www.bing.com/search?q={q}" },
    { id: "baidu", name: "百度", url: "https://www.baidu.com/s?wd={q}" },
    { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q={q}" },
];

/** 默认设置 */
export const DEFAULT_SETTINGS: BrowserSettings = {
    homepage: "https://www.bing.com",
    searchEngine: "bing",
    customSearchUrl: "",
    historyLimit: 5000,
    recordHistory: true,
    downloadTarget: "assets",
    userAgent: "",
    proxyMode: "system" as ProxyMode,
    proxyCustomUrl: "",
    enablePreload: true,
    excerptNotebook: "",
    excerptParentPath: "/",
    excerptTags: "",
    excerptAssets: true,
    excerptExpBold: false,
    excerptExpItalic: false,
    excerptExpUnderline: false,
    excerptExpRemoveImgLink: false,
    excerptExpSpan: false,
    excerptExpSvgToImg: false,
    interceptAllLinks: false,
    excludedSites: "github.com",
    adBlockEnabled: true,
    adBlockRules: "",
};

/** 历史上限硬上限 */
export const HISTORY_HARD_LIMIT = 50000;
/** 浏览器页签 webview 的专用 session partition（扩展加载/session API 共用） */
export const BROWSER_PARTITION = "persist:siyuan-browser";

/** 下载并发数 */
export const MAX_CONCURRENT_DOWNLOADS = 3;

/** Google s2 favicon 服务 */
export const FAVICON_SERVICE = "https://www.google.com/s2/favicons?domain={domain}&sz=64";
