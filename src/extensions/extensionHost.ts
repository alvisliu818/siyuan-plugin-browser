import { Dialog, showMessage } from "siyuan";
import type { IWebviewTag } from "../types";
import { parseExtensionPackage } from "./crx";
import { EDGE_ADDONS_HOME, downloadEdgeCrx, fetchEdgeAddonMeta, parseEdgeAddonId } from "./edgeStore";
import { disposeCsRuntime, ensureCsRuntime, initCsRuntime, seedExtensionKernelSettings } from "./cs-runtime";
import { remoteSession } from "../utils/electron";

/**
 * Chrome 扩展支持（模拟扩展宿主）。
 *
 * Electron 的 session.loadExtension 仅在主进程可用，插件运行在渲染进程无法调用，
 * 因此这里实现一个轻量扩展宿主：
 * - 从本地目录读取未打包扩展（manifest.json + content scripts），或安装 CRX / ZIP 扩展包
 *   （CRX 头解析后解压到插件存储目录再按目录安装）
 * - 原生模式优先：通过 @electron/remote 调用主进程 session.loadExtension 装入
 *   webview 专用 partition（persist:siyuan-browser），由 Chromium 运行真正的扩展
 *   （内容脚本隔离世界、chrome-extension:// 资源、background 视 Electron 支持程度）。
 *   原生不可用/加载失败的扩展回退到下述垫片模式
 * - 垫片模式：在 webview 每次页面加载完成（dom-ready）后按 match pattern 注入内容脚本与样式
 * - 提供常用 chrome.* API 垫片：storage（localStorage 持久化）/ i18n / runtime.getURL
 *
 * 已知限制（v1）：
 * - 不执行 background / service_worker / popup 页面
 * - 内容脚本运行在页面主世界（isolated world 不可用）
 * - chrome.runtime.sendMessage 无接收方（background 未执行）
 */

export interface IInstalledExtension {
    /** 稳定 id（路径哈希） */
    id: string;
    name: string;
    version: string;
    description: string;
    /** 扩展目录绝对路径 */
    path: string;
    enabled: boolean;
    manifestVersion: number;
    /** manifest 声明了 background（当前版本不执行，仅提示） */
    hasBackground: boolean;
    /** 默认 locale（i18n 垫片用） */
    defaultLocale: string;
    /** content_scripts 配置（安装时快照） */
    contentScripts: Array<{ matches: string[]; js: string[]; css: string[] }>;
    /** 原生模式：已通过 session.loadExtension 装入 webview partition（Chromium 注入内容脚本，垫片不再介入） */
    native?: boolean;
    /** 原生模式下 Electron 侧的扩展 id（removeExtension 用） */
    electronId?: string;
    /** 原生加载失败原因（为空且 native=false 时表示垫片模式正常） */
    nativeError?: string;
    /** manifest.action.default_popup 的相对路径（工具栏图标点击后展示的面板） */
    popupPath?: string;
    /** manifest.action.default_title（图标悬停提示，缺省回退 name） */
    actionTitle?: string;
    /** manifest.icons 里最大尺寸的图标相对路径（工具栏显示用） */
    iconPath?: string;
}

const EXTENSIONS_KEY = "extensions.json";

/** 简易字符串哈希（扩展 id 生成用） */
function strHash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function nodeModules() {
    const req = (window as any).require;
    return {
        fs: req("fs") as typeof import("fs"),
        path: req("path") as typeof import("path"),
        os: req("os") as typeof import("os"),
        ipcRenderer: req("electron")?.ipcRenderer,
    };
}

// === Chrome match pattern（https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns）===

export function matchesUrlPattern(pattern: string, rawUrl: string): boolean {
    if (pattern === "<all_urls>") {
        return /^https?:\/\//i.test(rawUrl);
    }
    const m = pattern.match(/^(\*|https?|file|ftp|urn):\/\/(\*(?:\.[^/*]+)?|\*|[^/*]+)(\/.*)$/);
    if (!m) return false;
    const [, scheme, hostPat, pathPat] = m;
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }
    const urlScheme = url.protocol.replace(":", "");
    if (scheme === "*") {
        if (urlScheme !== "http" && urlScheme !== "https") return false;
    } else if (scheme !== urlScheme) {
        return false;
    }
    const host = url.hostname;
    // patterns 允许带端口，优先按 host（含端口）比较
    const hostWithPort = url.host;
    const hostMatches = (pat: string) => pat === host || pat === hostWithPort;
    if (hostPat === "*") {
        // 任意主机
    } else if (hostPat.startsWith("*.")) {
        const base = hostPat.slice(2);
        if (!hostMatches(base) && !host.endsWith("." + base) && !hostWithPort.endsWith("." + base)) return false;
    } else if (!hostMatches(hostPat)) {
        return false;
    }
    // path：把 pattern 转成正则（* → .*）
    const path = url.pathname + url.search;
    const regex = new RegExp(
        "^" + pathPat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );
    return regex.test(path);
}

export class ExtensionHost {
    private plugin: any;
    private extensions: IInstalledExtension[] = [];
    private loaded = false;
    /** 扩展文件内容缓存（key: path:file） */
    private fileCache: Map<string, string> = new Map();

    constructor(plugin: any) {
        this.plugin = plugin;
        // manager 与页面无关，构造即就绪（popup 可在 about:blank 等非 http 页上打开）
        this.initCsRuntimeOnce();
    }

    private readFileCached(extPath: string, rel: string): string {
        const key = extPath + ":" + rel;
        let content = this.fileCache.get(key);
        if (content == null) {
            const { fs, path } = nodeModules();
            content = fs.readFileSync(path.join(extPath, rel), "utf8");
            this.fileCache.set(key, content);
        }
        return content;
    }

    async load(): Promise<void> {
        try {
            const data = await this.plugin.loadData(EXTENSIONS_KEY);
            this.extensions = data ? (typeof data === "string" ? JSON.parse(data) : data) : [];
        } catch {
            this.extensions = [];
        }
        this.backfillManifestExtras();
        await this.backfillI18nNames();
        await this.injectBackgroundShims();
        await this.neutralizeNativeContentScripts();
        // Electron 的 session 扩展不跨重启持久化，启动时全部恢复（原生优先，失败回退垫片）
        await this.reconcileNative();
        this.loaded = true;
        // 数据就绪广播：思源恢复标签时 BrowserTab 可能在 load() 完成前构造，
        // 那时画的图标区是空的 —— 监听方收到此事件后重画。
        try {
            window.dispatchEvent(new CustomEvent("sy-browser-ext-host-loaded"));
        } catch {}
        // 内核地址/token 自动填充（SiYuan Clip 配置播种）：不阻塞，失败下次启动重试
        void seedExtensionKernelSettings();
    }

    /**
     * 给 MV3 扩展的 service_worker 注入兼容垫片（写回扩展目录的 background 文件）。
     *
     * 动机：Electron 不支持 chrome.contextMenus（依赖 Google 服务那批 API 一样缺），
     * 而不少扩展 background 的**第一行**就是 contextMenus.create —— 不存在直接抛
     * "Cannot read properties of undefined"，整个 service worker 起不来，
     * 该扩展的消息监听、右键菜单全部瘫痪（实测 SiYuan Clip 因此 SW 缺席）。
     *
     * 垫片只补"存在性"：contextMenus 记录注册项、onClicked 转发到 storage 通道，
     * 让 SW 至少能跑完初始化。菜单的真正触发由宿主写 storage 完成（见 contextMenu.ts）。
     *
     * 幂等：文件头有标记就跳过；扩展更新（文件重写）后标记消失会重新注入。
     */
    private async injectBackgroundShims(): Promise<void> {
        const { fs, path } = nodeModules();
        const SHIM_MARK = "/* sy-bg-shim:v15 */";
        let changedShimCount = 0;
        for (const ext of this.extensions) {
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(ext.path, "manifest.json"), "utf8"));
                const swPath = manifest.background?.service_worker;
                if (!swPath) continue;
                const abs = path.join(ext.path, swPath);
                const src = fs.readFileSync(abs, "utf8");
                if (src.startsWith(SHIM_MARK)) continue;
                // 只在真的用到缺失 API 时才垫（省得污染没问题的扩展）
                const needsShim = /chrome\.(contextMenus|commands|action|browserAction|notifications|cookies|downloads|webNavigation|alarms|omnibox)/.test(src);
                if (!needsShim) continue;
                const shim = SHIM_MARK + `
;(function () {
    try {
        if (typeof chrome === "undefined") return;
        // 0) onMessage handlers 收集数组：无条件最顶部创建 —— background 顶层的
        //    addListener 稍后 push 进同一数组；宿主 routeSendMessage 据此判断
        //    "handler 已注册（非空）" 还是 "仍在启动期（空 → 重试）"。
        //    （此前数组在 onMessage 包装内创建，若包装条件不满足则数组缺失，
        //    宿主会误报 "垫片未运行" 且无重试依据。）
        self.__syOnMessageHandlers = self.__syOnMessageHandlers || [];
        // 1) 通用存在性垫片：background 里引用到的缺失命名空间统一补空壳，
        //    否则任何一处 undefined 访问都会让 SW 整个崩掉（实测 SiYuan Clip
        //    第一行 contextMenus、中段 commands 各崩一次）。
        var eventHub = function () {
            var fns = [];
            return {
                addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                __emit: function () { var a = arguments; fns.forEach(function (fn) { try { fn.apply(null, a); } catch (e) {} }); },
            };
        };
        var MISSING = ["contextMenus", "commands", "action", "browserAction", "pageAction",
            "notifications", "cookies", "downloads", "webNavigation", "webRequest",
            "declarativeNetRequest", "idle", "alarms", "permissions", "sessions",
            "topSites", "bookmarks", "history", "omnibox", "pageCapture"];
        MISSING.forEach(function (ns) {
            if (chrome[ns]) return;
            chrome[ns] = { onChanged: eventHub() };
            // 常见事件口补 addListener（保证注册不抛）
            ["onClicked", "onCommand", "onInstalled", "onStartup", "onChanged"].forEach(function (ev) {
                chrome[ns][ev] = eventHub();
            });
        });
        // 引擎拦截链需要 webRequest/webNavigation 的**全套请求事件**
        // （v4 空壳只补了 5 个通用事件 → AdGuard engine 启动报 .addListener undefined）
        try {
            var REQ_EVENTS = ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived",
                "onAuthRequired", "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"];
            var NAV_EVENTS = ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted",
                "onErrorOccurred", "onCreatedNavigationTarget", "onReferenceFragmentUpdated",
                "onTabReplaced", "onHistoryStateUpdated", "onDomainChanged"];
            ["webRequest", "declarativeNetRequest"].forEach(function (ns) {
                if (!chrome[ns]) chrome[ns] = {};
                REQ_EVENTS.forEach(function (ev) {
                    if (!chrome[ns][ev] || typeof chrome[ns][ev].addListener !== "function") chrome[ns][ev] = eventHub();
                });
            });
            if (!chrome.webNavigation) chrome.webNavigation = {};
            NAV_EVENTS.forEach(function (ev) {
                if (!chrome.webNavigation[ev] || typeof chrome.webNavigation[ev].addListener !== "function") chrome.webNavigation[ev] = eventHub();
            });
            // privacy 壳（AdGuard StealthService 调 privacy.network.webRTCIPHandlingPolicy）
            if (!chrome.privacy) chrome.privacy = {};
            if (!chrome.privacy.network) chrome.privacy.network = {};
            ["webRTCIPHandlingPolicy", "networkPredictionEnabled"].forEach(function (k) {
                if (!chrome.privacy.network[k]) chrome.privacy.network[k] = {
                    get: function (d, cb) { var v = { value: "default" }; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); },
                    set: function (d, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); },
                    clear: function (d, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); },
                };
            });
            if (!chrome.webNavigation.getAllFrames) chrome.webNavigation.getAllFrames = function (opts, cb) { var v = []; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
        } catch (e) {}
        // 6) 给 webextension-polyfill 的 browser 对象补 webNavigation：
        //    polyfill 的 schema 天生不含 webNavigation（AdGuard 代码却引用
        //    browser.webNavigation.*），垫片执行时 polyfill 尚未构建，故延迟一拍
        //    注入 —— 晚于 polyfill 构建、早于 engine.start 的异步流程。
        setTimeout(function () {
            try {
                if (typeof browser !== "undefined" && browser && !browser.webNavigation && chrome.webNavigation) {
                    browser.webNavigation = chrome.webNavigation;
                }
            } catch (e) {}
        }, 0);
        // commands 补 API 形态（manifest 里声明的快捷键注册）
        if (chrome.commands && !chrome.commands.getAll) {
            chrome.commands.getAll = function (cb) { cb && cb([]); };
        }
        // 3) onInstalled 补发：Electron 不触发 runtime.onInstalled，而不少扩展
        //    把 contextMenus.create 全放它的回调里（实测 SiYuan Clip）——
        //    不补发则菜单注册永不执行。SW 每次唤醒补发一次正符合
        //    "重启需重新注册内存态菜单"的生命周期语义。
        try {
            if (chrome.runtime && chrome.runtime.onInstalled && !chrome.runtime.onInstalled.__syWrapped) {
                var oiFns = [];
                var wrapped = {
                    addListener: function (fn) { if (typeof fn === "function") oiFns.push(fn); },
                    removeListener: function (fn) { var i = oiFns.indexOf(fn); if (i >= 0) oiFns.splice(i, 1); },
                };
                Object.defineProperty(chrome.runtime, "onInstalled", {
                    configurable: true,
                    get: function () { return wrapped; },
                });
                wrapped.__syWrapped = true;
                // Chromium 原生触发在 Electron 下不存在；延迟让扩展先完成顶层注册
                setTimeout(function () {
                    oiFns.forEach(function (fn) { try { fn({ reason: "install" }); } catch (e) {} });
                }, 200);
            }
        } catch (e) {}
        // 2) contextMenus 特化：记录注册项，点击经 storage 通道由宿主触发
        if (!chrome.contextMenus.__syStore) {
            var store = { items: {}, click: eventHub() };
            chrome.contextMenus.removeAll = function (cb) { store.items = {}; if (cb) cb(); };
            chrome.contextMenus.create = function (props) { if (props && props.id) store.items[props.id] = props; };
            chrome.contextMenus.onClicked = store.click;
            chrome.contextMenus.__syStore = store;
            self.__syContextMenuStore = store;
            // 宿主点击菜单 → 写 storage → 这里触发 onClicked
            if (chrome.storage && chrome.storage.onChanged) {
                chrome.storage.onChanged.addListener(function (changes, area) {
                    try {
                        if (area !== "local" || !changes.__syMenuClick) return;
                        var p = changes.__syMenuClick.newValue;
                        store.click.__emit(p.info, p.tab);
                    } catch (e) {}
                });
            }
        }
        // 3) runtime.onMessage 路由（CS→SW 方向的通用替代）：
        //    Electron 没实现 SW↔CS 消息路由（SW 的 tabs.sendMessage 恒报
        //    "Receiving end does not exist"，CS 的 runtime.sendMessage 同理静默丢失）。
        //    这里包装 onMessage.addListener 收集扩展注册的 handlers，
        //    配合 storage 通道（__syRouteIn 请求 / __syRouteResp_<id> 响应）
        //    用官方 chrome.storage 实现两端路由 —— storage 在 CS 和 SW 里
        //    都是真实可用的（实测）。CS 侧的发送端 shim 由 sw-bridge 经 CDP
        //    注入到扩展的 isolated world。
        try {
            if (chrome.runtime && chrome.runtime.onMessage && !chrome.runtime.onMessage.__syWrapped) {
                var omFns = [];
                var omWrapped = {
                    addListener: function (fn) { if (typeof fn === "function") omFns.push(fn); },
                    removeListener: function (fn) { var i = omFns.indexOf(fn); if (i >= 0) omFns.splice(i, 1); },
                };
                Object.defineProperty(chrome.runtime, "onMessage", {
                    configurable: true,
                    get: function () { return omWrapped; },
                });
                omWrapped.__syWrapped = true;
                self.__syOnMessageHandlers = omFns;
                if (chrome.storage && chrome.storage.onChanged) {
                    chrome.storage.onChanged.addListener(function (changes, area) {
                        try {
                            if (area !== "local" || !changes.__syRouteIn || !changes.__syRouteIn.newValue) return;
                            var env = changes.__syRouteIn.newValue;
                            if (!env || typeof env.reqId === "undefined") return;
                            var responded = false;
                            var sendResponse = function (resp) {
                                if (responded) return;
                                responded = true;
                                var key = "__syRouteResp_" + env.reqId;
                                var item = {};
                                item[key] = { resp: resp === undefined ? null : resp };
                                try { chrome.storage.local.set(item); } catch (e) {}
                            };
                            var anySync = false;
                            omFns.forEach(function (fn) {
                                try {
                                    var r = fn(env.msg, env.sender || { id: "sy-host" }, sendResponse);
                                    if (r === true) {
                                        // handler 返回 true 表示异步 sendResponse，等待其回调
                                    } else if (r !== undefined) {
                                        anySync = true;
                                        sendResponse(r);
                                    }
                                } catch (e) {}
                            });
                            if (!anySync && omFns.length === 0) sendResponse(undefined);
                        } catch (e) {}
                    });
                }
            }
        } catch (e) {}
        // 4) runtime.onConnect 端口语义（AdGuard 等经 port 与 SW 通信取状态）：
        //    Electron 没实现扩展间 port 路由。这里收集 onConnect listeners；
        //    宿主（cs-runtime routePortMessage）经 CDP 建连时构造 port 对象派发，
        //    port.postMessage 写入 outbox、由宿主轮询带回页面世界。
        try {
            if (chrome.runtime && chrome.runtime.onConnect && !chrome.runtime.onConnect.__syWrapped) {
                var ocFns = [];
                var ocWrapped = {
                    addListener: function (fn) { if (typeof fn === "function") ocFns.push(fn); },
                    removeListener: function (fn) { var i = ocFns.indexOf(fn); if (i >= 0) ocFns.splice(i, 1); },
                };
                Object.defineProperty(chrome.runtime, "onConnect", {
                    configurable: true,
                    get: function () { return ocWrapped; },
                });
                ocWrapped.__syWrapped = true;
                self.__syOnConnectFns = ocFns;
                self.__syPorts = self.__syPorts || {};
                self.__syPortOutbox = self.__syPortOutbox || {};
            }
        } catch (e) {}
        // 5) chrome.tabs 事件收集（AdGuard 等靠 onCreated/onUpdated 维护 tabContext，
        //    Electron SW 里这些事件永不触发 → 扩展取 tab 状态时 getTabContext 恒
        //    undefined → popup 卡 loading）。宿主经 "tabevent" 通道手工喂 tab。
        try {
            if (chrome.tabs && !chrome.tabs.__syTabWrapped) {
                // 5a) tabs API 补桩：Electron 原生 tabs 缺 create/update/remove 等，
                //     AdGuard onInstalled 流程调 tabs.create 直接 TypeError →
                //     初始化链中断（tabsApi.start 永不执行 → popup 取状态卡 loading）
                if (!chrome.tabs.create) chrome.tabs.create = function (props, cb) { var t = { id: 1, index: 0, windowId: 1, active: true, url: (props && props.url) || "" }; if (typeof cb === "function") { try { cb(t); } catch (e) {} } return Promise.resolve(t); };
                if (!chrome.tabs.update) chrome.tabs.update = function (id, props, cb) { var t = { id: typeof id === "number" ? id : 1, url: (props && props.url) || "" }; if (typeof cb === "function") { try { cb(t); } catch (e) {} } return Promise.resolve(t); };
                if (!chrome.tabs.remove) chrome.tabs.remove = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
                if (!chrome.tabs.get) chrome.tabs.get = function (id, cb) { var t = { id: id, index: 0, windowId: 1, active: false, url: "" }; if (typeof cb === "function") { try { cb(t); } catch (e) {} } return Promise.resolve(t); };
                if (!chrome.tabs.reload) chrome.tabs.reload = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
                if (chrome.tabs.TAB_ID_NONE === undefined) chrome.tabs.TAB_ID_NONE = -1;
                // 5c) permissions API 补桩：AdGuard 引擎启动链调 permissions.contains
                //     （Electron 原生缺失 → "Cannot be started"）。MV3 所需权限默认放行。
                if (chrome.permissions) {
                    if (!chrome.permissions.contains) chrome.permissions.contains = function (perms, cb) { var v = true; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                    if (!chrome.permissions.request) chrome.permissions.request = function (perms, cb) { var v = true; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                    if (!chrome.permissions.remove) chrome.permissions.remove = function (perms, cb) { var v = true; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                    if (!chrome.permissions.getAll) chrome.permissions.getAll = function (cb) { var v = { origins: [], permissions: [] }; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                }
                // 5b) tabs 事件收集（AdGuard 等靠 onCreated/onUpdated 维护 tabContext，
                //     Electron SW 里这些事件永不触发 → 宿主经 "tabevent" 通道手工喂 tab）
                var tcFns = [], tuFns = [], taFns = [];
                var tabEvFor = function (fns) {
                    return {
                        addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                        removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                        hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
                    };
                };
                try { Object.defineProperty(chrome.tabs, "onCreated", { configurable: true, get: function () { return tabEvFor(tcFns); } }); } catch (e) { chrome.tabs.onCreated = tabEvFor(tcFns); }
                try { Object.defineProperty(chrome.tabs, "onUpdated", { configurable: true, get: function () { return tabEvFor(tuFns); } }); } catch (e) { chrome.tabs.onUpdated = tabEvFor(tuFns); }
                try { Object.defineProperty(chrome.tabs, "onActivated", { configurable: true, get: function () { return tabEvFor(taFns); } }); } catch (e) { chrome.tabs.onActivated = tabEvFor(taFns); }
                chrome.tabs.__syTabWrapped = true;
                self.__syTabCreatedFns = tcFns;
                self.__syTabUpdatedFns = tuFns;
                self.__syTabActivatedFns = taFns;
                // 5d) tabs.sendMessage 回程路由：Electron 原生实现恒报
                //     "Receiving end does not exist"（SW↔CS 消息路由缺失）——
                //     剪藏 tip/结果回不到页面、lastError 刷屏的根因。请求写
                //     __syTabsOutbox，宿主在 routeSendMessage 后的监听窗口内
                //     轮询取走 → 派发到 content 世界 → evalInSw 写回 __syTabsPending。
                try {
                    var tsmSeq = 0;
                    var tsm = function (tabId, msg, cb, respCb) {
                        var callback = typeof cb === "function" ? cb : (typeof respCb === "function" ? respCb : null);
                        var rid = "t" + (++tsmSeq) + "_" + Date.now().toString(36);
                        self.__syTabsOutbox = self.__syTabsOutbox || [];
                        self.__syTabsOutbox.push({ id: rid, tabId: typeof tabId === "number" ? tabId : null, msg: msg === undefined ? null : msg });
                        if (callback) {
                            self.__syTabsPending = self.__syTabsPending || {};
                            self.__syTabsPending[rid] = function (respJson) {
                                delete self.__syTabsPending[rid];
                                var resp;
                                try { resp = respJson == null ? undefined : JSON.parse(respJson); } catch (e3) { resp = undefined; }
                                try { callback(resp); } catch (e3) {}
                            };
                            setTimeout(function () {
                                if (self.__syTabsPending && self.__syTabsPending[rid]) {
                                    delete self.__syTabsPending[rid];
                                    try { callback(undefined); } catch (e3) {}
                                }
                            }, 20000);
                        }
                    };
                    try { Object.defineProperty(chrome.tabs, "sendMessage", { configurable: true, get: function () { return tsm; } }); }
                    catch (e2) { chrome.tabs.sendMessage = tsm; }
                } catch (e) {}
            }
        } catch (e) {}
        // 5e) chrome.storage.sync 修复：Electron SW 原生 sync.get 回调 undefined
        //     （实测 SiYuan Clip storageSyncGet 拿到 undefined → 解构抛 TypeError
        //     → article 剪藏流程崩进 catch → tip_siyuan_kernel_unavailable）。
        //     与宿主 CS 代理同策略：sync 代理到 local（CS 世界经宿主代理同样落
        //     在 SW 的 storage.local，数据同源）。
        try {
            if (chrome.storage && (!chrome.storage.sync || !chrome.storage.sync.__syShim)) {
                var syncArea = {
                    __syShim: true,
                    get: function (keys, cb) {
                        var done = function (v) { if (typeof cb === "function") { try { cb(v == null ? {} : v); } catch (e3) {} } };
                        try {
                            var p = chrome.storage.local.get(keys == null ? {} : keys, done);
                            if (p && typeof p.then === "function") p.then(function (v) { done(v); }, function () { done({}); });
                            return p;
                        } catch (e2) { done({}); }
                    },
                    set: function (items, cb) { return chrome.storage.local.set(items == null ? {} : items, cb); },
                    remove: function (keys, cb) { return chrome.storage.local.remove(keys == null ? [] : keys, cb); },
                    clear: function (cb) { return chrome.storage.local.clear(cb); },
                    getBytesInUse: function (keys, cb) { var v = 0; if (typeof cb === "function") { try { cb(v); } catch (e3) {} } return Promise.resolve(v); },
                };
                try { Object.defineProperty(chrome.storage, "sync", { configurable: true, get: function () { return syncArea; } }); }
                catch (e2) { chrome.storage.sync = syncArea; }
            }
        } catch (e) {}
    } catch (e) {}
})();
`;
                fs.writeFileSync(abs, shim + src, "utf8");
                changedShimCount++;
            } catch (e) {
                // 单个扩展垫片失败不影响其它 —— 但必须留痕：静默吞掉会让扩展
                // 以无垫片状态长期运行（实测 TM 2026-10-09 起三周无垫片、SW
                // handlers 恒空、油猴消息全挂，因每次启动注入都失败而无感知）。
                console.warn("[browser-plugin] injectBackgroundShims failed for",
                    ext.name || ext.path, ":", e instanceof Error ? e.message : e);
                // 大文件瞬时锁（Defender/索引服务）常亚秒级消失：延迟重试一次
                try {
                    await new Promise((r) => setTimeout(r, 500));
                    const manifest2 = JSON.parse(fs.readFileSync(path.join(ext.path, "manifest.json"), "utf8"));
                    const swPath2 = manifest2.background?.service_worker;
                    const abs2 = swPath2 ? path.join(ext.path, swPath2) : "";
                    const src2 = abs2 ? fs.readFileSync(abs2, "utf8") : "";
                    const needsShim2 = !!src2 && /contextMenus|userScripts|notifications|webNavigation|alarms|omnibox|declarativeNetRequest|cookies|browserAction|browser_action|chrome\.(commands|action|downloads)/.test(src2);
                    if (src2 && needsShim2 && !src2.startsWith(SHIM_MARK)) {
                        const shim2 = SHIM_MARK + shimBody;
                        let original2 = src2;
                        if (/^\/\* sy-bg-shim:v\d+[^*]*\*\//.test(original2)) {
                            const endMark2 = "/* sy-bg-shim-end */";
                            const ei2 = original2.lastIndexOf(endMark2);
                            if (ei2 >= 0) original2 = original2.slice(ei2 + endMark2.length).replace(/^\s*\n/, "");
                        }
                        fs.writeFileSync(abs2, shim2 + original2, "utf8");
                        changedShimCount++;
                        console.warn("[browser-plugin] injectBackgroundShims retry ok:", ext.name || ext.path);
                    }
                } catch (e2) {
                    console.warn("[browser-plugin] injectBackgroundShims retry failed for",
                        ext.name || ext.path, ":", e2 instanceof Error ? e2.message : e2);
                }
            }
        }
        if (changedShimCount > 0) {
            // 垫片改了 SW 源码，Electron 侧的已加载扩展需要卸掉重载 ——
            // reconcileNative（紧随其后调用）发现原生缺席会重新 loadExtension
            const ses = remoteSession();
            if (ses?.getAllExtensions && ses.unloadExtension) {
                for (const x of ses.getAllExtensions()) {
                    try { ses.unloadExtension(x.id); } catch {}
                }
            }
            // 关键：分区里持久化的 SW 注册/脚本缓存不随 loadExtension 更新
            // （实测：background.js 已重写为 v13，重载后 SW 仍执行 v12 旧脚本）。
            // 清掉 SW 存储后，重载注册必然从磁盘拉新脚本。仅垫片版本变更时执行；
            // 网站自身的 SW 被清后下次访问会自动重注册，无感。
            if (ses?.clearStorageData) {
                try {
                    await ses.clearStorageData({ storages: ["serviceworkers"] });
                } catch {}
            }
        }
    }

    /**
     * 根源方案：清空原生加载扩展 manifest 的 content_scripts（磁盘重写）。
     *
     * 动机：session.loadExtension 会让 Chromium 向每个页面的原生 isolated world
     * 注入一份 content script 副本。Chromium 152 起该副本不再是"空壳死代码"——
     * chrome.storage.sync **调用**即抛 `"sync" is not available in this instance
     * of Chrome`，runtime.sendMessage 报 Receiving end，且副本会初始化自己的
     * UI/状态机（与自建世界副本形成双份竞争，如 Clip 的 tip 状态卡死）。
     * 事后消音（unhandledrejection/error 事件）永远晚于副本顶层执行，且治标不治本。
     *
     * 做法：manifest.json 的 content_scripts 重写为空数组（原始值备份到
     * manifest.orig.json，installFromPath 重装时会先恢复）→ Chromium 原生不再
     * 注入任何副本 → 报错源头消失。功能不受影响：cs-runtime 自建世界本来就
     * 独立从磁盘读 content script 文件执行（extensions.json 的 contentScripts
     * 记录在安装时解析，与磁盘 manifest 解耦）。
     *
     * 幂等：content_scripts 已空则跳过；扩展更新覆盖 manifest 后会重新清空。
     */
    private async neutralizeNativeContentScripts(): Promise<void> {
        const { fs, path } = nodeModules();
        let changed = false;
        for (const ext of this.extensions) {
            if (!ext.enabled) continue;
            try {
                const manifestPath = path.join(ext.path, "manifest.json");
                const origPath = path.join(ext.path, "manifest.orig.json");
                const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                const groups = manifest.content_scripts || [];
                if (groups.length === 0) continue;
                // 原始 manifest 只在首次清空时备份（此后 manifest 已无 CS，避免
                // 用清空版覆盖备份）
                if (!fs.existsSync(origPath)) {
                    fs.writeFileSync(origPath, JSON.stringify(manifest, null, 2), "utf8");
                }
                manifest.content_scripts = [];
                fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
                changed = true;
            } catch {
                // 单个扩展失败不影响其它
            }
        }
        if (changed) {
            // 已加载的原生扩展需要卸掉重载才会按新 manifest 运行；
            // reconcileNative（紧随其后调用）发现原生缺席会重新 loadExtension
            const ses = remoteSession();
            if (ses?.getAllExtensions && ses.unloadExtension) {
                for (const x of ses.getAllExtensions()) {
                    try { ses.unloadExtension(x.id); } catch {}
                }
            }
        }
    }

    /**
     * 给旧版本安装的扩展补齐 popupPath / actionTitle / iconPath。
     * 这三个字段是工具栏图标功能加的，只在安装时从 manifest 解析；
     * 存量数据里没有，读盘时按需补算，否则工具栏永远空白。
     */
    /**
     * 旧数据回填：name/description 仍是 __MSG_xxx__ 占位符的条目，按磁盘上的
     * manifest + _locales 重新解析（安装时的解析可能因当时代码缺陷/环境问题
     * 失败并被原样持久化，如 AdGuard 的 "__MSG_name__"）。
     */
    private async backfillI18nNames(): Promise<void> {
        const pending = this.extensions.filter((e) => /__MSG_/.test(e.name) || /__MSG_/.test(e.description || ""));
        if (pending.length === 0) return;
        const { fs, path } = nodeModules();
        let changed = false;
        for (const ext of pending) {
            try {
                const manifestPath = path.join(ext.path, "manifest.json");
                if (!fs.existsSync(manifestPath)) continue;
                const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                const locale = manifest.default_locale || ext.defaultLocale || "";
                const newName = this.resolveManifestString(manifest.name || ext.name, ext.path, locale);
                const newDesc = this.resolveManifestString(manifest.description || ext.description || "", ext.path, locale);
                if (newName && newName !== ext.name) {
                    ext.name = newName;
                    changed = true;
                }
                if (newDesc && newDesc !== ext.description) {
                    ext.description = newDesc;
                    changed = true;
                }
            } catch {}
        }
        if (changed) {
            await this.persist();
            console.log(`[browser-plugin] 回填 ${pending.length} 个扩展的 i18n 名称`);
        }
    }

    private backfillManifestExtras(): void {
        const { fs, path } = nodeModules();
        let changed = false;
        for (const ext of this.extensions) {
            if (ext.popupPath !== undefined && ext.iconPath !== undefined) continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(ext.path, "manifest.json"), "utf8"));
                if (ext.popupPath === undefined) {
                    ext.popupPath = (manifest.action?.default_popup
                        || manifest.browser_action?.default_popup
                        || manifest.page_action?.default_popup
                        || undefined);
                }
                if (ext.actionTitle === undefined) {
                    ext.actionTitle = manifest.action?.default_title
                        || manifest.browser_action?.default_title
                        || manifest.page_action?.default_title
                        || undefined;
                }
                if (ext.iconPath === undefined) {
                    ext.iconPath = pickLargestIcon(manifest);
                }
                changed = true;
            } catch {
                // manifest 读不到（目录被删等）：留空，工具栏会跳过该项
                ext.popupPath = ext.popupPath ?? undefined;
                ext.iconPath = ext.iconPath ?? undefined;
                changed = true;
            }
        }
        if (changed) void this.plugin.saveData(EXTENSIONS_KEY, JSON.stringify(this.extensions));
    }

    /**
     * 尝试用 Electron 原生扩展运行时（session.loadExtension）加载扩展。
     * 可用且加载成功 → native=true（内容脚本由 Chromium 注入隔离世界，垫片不介入）；
     * 不可用或失败 → native=false + nativeError，走垫片注入。
     */
    private async reconcileNative(): Promise<void> {
        const ses = remoteSession();
        if (!ses) {
            for (const ext of this.extensions) {
                ext.native = false;
                ext.nativeError = undefined;
            }
            return;
        }
        let changed = false;
        for (const ext of this.extensions) {
            if (!ext.enabled) {
                if (ext.native) {
                    try {
                        ext.electronId && ses.removeExtension(ext.electronId);
                    } catch {}
                    ext.native = false;
                    changed = true;
                }
                continue;
            }
            try {
                // 同路径已加载（如重启后 session 仍保留）→ 直接同步 id，不重复加载
                const normPath = ext.path.replace(/\\/g, "/");
                const existing = (ses.getAllExtensions?.() || []).find(
                    (x: any) => x.path && x.path.replace(/\\/g, "/") === normPath
                );
                let info = existing;
                if (!info) {
                    info = await ses.loadExtension(ext.path, { allowFileAccess: true });
                }
                if (ext.native !== true || ext.electronId !== info.id) changed = true;
                ext.native = true;
                ext.electronId = info.id;
                ext.nativeError = undefined;
            } catch (e: any) {
                if (ext.native !== false) changed = true;
                ext.native = false;
                ext.nativeError = String(e?.message || e);
            }
        }
        if (changed) await this.persist();
    }

    private async persist(): Promise<void> {
        await this.plugin.saveData(EXTENSIONS_KEY, JSON.stringify(this.extensions));
    }

    list(): IInstalledExtension[] {
        return [...this.extensions];
    }

    /** 能弹出面板的扩展（有 action/browser_action 的 default_popup 且已启用） */
    listActionable(): IInstalledExtension[] {
        return this.extensions.filter((e) => e.enabled && e.popupPath);
    }

    /** 解析 manifest 字段里的 __MSG_xxx__ 占位符（_locales 消息），失败时原样返回 */
    private resolveManifestString(value: string, extPath: string, defaultLocale: string): string {
        const m = String(value || "").match(/^__MSG_(.+?)__$/);
        if (!m) return value;
        const locales = [defaultLocale, "en", "zh_CN"].filter(Boolean);
        for (const locale of locales) {
            try {
                const raw = this.readFileCached(extPath, `_locales/${locale}/messages.json`);
                // 容错：部分扩展的 messages.json 带 BOM，直接 JSON.parse 会抛
                const messages = JSON.parse(raw.replace(/^\uFEFF/, ""));
                const msg = messages?.[m[1]]?.message;
                if (msg) return msg;
            } catch {}
        }
        return value;
    }

    /** 展开 ~ 与环境变量后读取目录下的 manifest.json */
    async installFromPath(rawDir: string): Promise<{ ok: boolean; error?: string; ext?: IInstalledExtension }> {
        const { fs, path, os } = nodeModules();
        let dir = this.expandPath(rawDir);
        try {
            // neutralizeNativeContentScripts 清空过 manifest 的扩展：先从备份恢复
            // 原始 manifest，保证重装时 contentScripts 记录完整（load 随后会再次清空）
            const origManifest = path.join(dir, "manifest.orig.json");
            const liveManifest = path.join(dir, "manifest.json");
            if (fs.existsSync(origManifest)) {
                try { fs.copyFileSync(origManifest, liveManifest); } catch {}
            }
            const manifestPath = liveManifest;
            if (!fs.existsSync(manifestPath)) {
                return { ok: false, error: "manifest.json not found: " + dir };
            }
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            if (!manifest || (!manifest.content_scripts && !manifest.name)) {
                return { ok: false, error: "invalid manifest.json" };
            }
            const normDir = dir.replace(/\\/g, "/");
            const displayName = this.resolveManifestString(manifest.name || path.basename(dir), normDir, manifest.default_locale || "");
            const displayDesc = this.resolveManifestString(manifest.description || "", normDir, manifest.default_locale || "");
            const contentScripts: IInstalledExtension["contentScripts"] = (manifest.content_scripts || []).map(
                (cs: any) => ({
                    matches: cs.matches || [],
                    js: cs.js || [],
                    css: cs.css || [],
                })
            );
            const ext: IInstalledExtension = {
                id: strHash(dir) + "-" + (manifest.version || "0"),
                name: displayName,
                version: manifest.version || "",
                description: displayDesc,
                path: normDir,
                enabled: true,
                manifestVersion: manifest.manifest_version || 2,
                hasBackground: !!(manifest.background || manifest.service_worker),
                defaultLocale: manifest.default_locale || "",
                contentScripts,
                // MV2 的入口是 browser_action/page_action，MV3 合并为 action
                popupPath: (manifest.action?.default_popup
                    || manifest.browser_action?.default_popup
                    || manifest.page_action?.default_popup
                    || undefined),
                actionTitle: manifest.action?.default_title
                    || manifest.browser_action?.default_title
                    || manifest.page_action?.default_title
                    || undefined,
                // 工具栏图标：取 manifest 里声明的最大尺寸
                iconPath: pickLargestIcon(manifest),
            };
            // 同目录重复安装 → 更新
            const idx = this.extensions.findIndex((e) => e.path === ext.path);
            if (idx >= 0) {
                this.extensions[idx] = ext;
            } else {
                this.extensions.push(ext);
            }
            // 原生运行时优先：loadExtension 成功则由 Chromium 接管内容脚本
            ext.native = false;
            ext.nativeError = undefined;
            try {
                // 装前先把垫片写进磁盘（新扩展目录已在 this.extensions 中）：
                // loadExtension 后 SW 从磁盘文件启动，无垫片的 SW 一起来就缺
                // handlers 收集数组（实测：会话中途安装的扩展要等下次重启注入
                // 成功才能用，期间消息全挂）。注入幂等，顺带修复其它缺失项；
                // 若触发了换版重写（changedShim>0 会 unload 全部原生扩展），
                // 由随后的 reconcileNative 统一恢复。
                await this.injectBackgroundShims();
                const ses = remoteSession();
                if (ses) {
                    const existing = (ses.getAllExtensions?.() || []).find((x: any) => x.path === ext.path);
                    const info = existing || (await ses.loadExtension(ext.path, { allowFileAccess: true }));
                    ext.native = true;
                    ext.electronId = info.id;
                    ext.nativeError = undefined;
                }
            } catch (e: any) {
                ext.nativeError = String(e?.message || e);
            }
            await this.reconcileNative();
            await this.persist();
            return { ok: true, ext };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
        }
    }

    private expandPath(raw: string): string {
        const { path, os } = nodeModules();
        let p = String(raw || "").trim().replace(/^"(.*)"$/, "$1");
        if (p.startsWith("~")) {
            p = path.join(os.homedir(), p.slice(1));
        }
        return p;
    }

    /**
     * 安装 CRX / ZIP 扩展包：解析 CRX 头取出 ZIP，解压到插件存储目录
     * （{workspace}/data/storage/petal/{plugin}/extensions/）后按目录安装。
     * 同一源文件重复安装 → 解压到同一目录 → 视为更新。
     */
    async installFromPackage(rawFile: string): Promise<{ ok: boolean; error?: string; ext?: IInstalledExtension }> {
        const { fs, path } = nodeModules();
        const file = this.expandPath(rawFile);
        try {
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
                return { ok: false, error: "file not found: " + file };
            }
            const parsed = parseExtensionPackage(fs.readFileSync(file));
            if (!parsed.ok || !parsed.zip) {
                return { ok: false, error: parsed.error };
            }
            // 懒加载：避免 adm-zip（及其对 node 内置模块的 require）在插件加载期执行
            const AdmZip: typeof import("adm-zip") = require("adm-zip");
            const zip = new AdmZip(parsed.zip);
            const baseName =
                path.basename(file).replace(/\.(crx|zip)$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim() || "extension";
            const workspaceDir = (window as any).siyuan?.config?.system?.workspaceDir;
            if (!workspaceDir) {
                return { ok: false, error: "workspaceDir unavailable" };
            }
            const extensionsRoot = path.join(
                workspaceDir,
                "data",
                "storage",
                "petal",
                this.plugin?.name || "siyuan-plugin-browser",
                "extensions"
            );
            const targetDir = path.join(extensionsRoot, `${baseName}-${strHash(file)}`);
            fs.rmSync(targetDir, { recursive: true, force: true });
            fs.mkdirSync(targetDir, { recursive: true });
            zip.extractAllTo(targetDir, true);
            // 包根目录没有 manifest.json 时，若所有条目都在唯一一层目录下则下钻一层
            let installDir = targetDir;
            if (!fs.existsSync(path.join(installDir, "manifest.json"))) {
                const tops = [...new Set(
                    zip.getEntries()
                        .map((e) => (e.entryName || "").split("/")[0])
                        .filter(Boolean)
                )];
                if (tops.length === 1 && fs.existsSync(path.join(targetDir, tops[0], "manifest.json"))) {
                    installDir = path.join(targetDir, tops[0]);
                } else {
                    return { ok: false, error: "manifest.json not found in package: " + path.basename(file) };
                }
            }
            return await this.installFromPath(installDir);
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
        }
    }

    /** 输入路径智能安装：CRX/ZIP 文件按包安装，目录按未打包扩展安装；Edge 加载项链接 / 扩展 ID 走商店下载 */
    async installFromInput(rawPath: string): Promise<{ ok: boolean; error?: string; ext?: IInstalledExtension }> {
        const { fs } = nodeModules();
        // Edge 加载项商店输入优先识别（32 位 [a-p] id 或商店详情页链接，与本地路径形态不冲突）
        if (parseEdgeAddonId(rawPath)) {
            return await this.installFromEdgeAddons(rawPath);
        }
        const p = this.expandPath(rawPath);
        try {
            if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                return await this.installFromPackage(p);
            }
        } catch {}
        return await this.installFromPath(p);
    }

    /**
     * 从 Microsoft Edge 加载项商店安装（https://microsoftedge.microsoft.com/addons）。
     * 接受详情页链接或 32 位扩展 ID：下载 CRX 落盘到
     * {petal}/extensions/download/edge-<id>.crx（路径稳定 → 同一扩展重复安装视为更新），
     * 再走通用包安装流程解压装入。
     */
    async installFromEdgeAddons(rawInput: string): Promise<{ ok: boolean; error?: string; ext?: IInstalledExtension }> {
        const { fs, path } = nodeModules();
        const id = parseEdgeAddonId(rawInput);
        if (!id) {
            return { ok: false, error: "invalid Edge Add-ons URL or extension id: " + String(rawInput).slice(0, 200) };
        }
        // 元数据仅用于错误提示增强与后续展示，获取失败不影响安装
        const meta = await fetchEdgeAddonMeta(id);
        try {
            const buf = await downloadEdgeCrx(id);
            const workspaceDir = (window as any).siyuan?.config?.system?.workspaceDir;
            if (!workspaceDir) {
                return { ok: false, error: "workspaceDir unavailable" };
            }
            const downloadDir = path.join(
                workspaceDir,
                "data",
                "storage",
                "petal",
                this.plugin?.name || "siyuan-plugin-browser",
                "extensions",
                "download"
            );
            fs.mkdirSync(downloadDir, { recursive: true });
            const crxFile = path.join(downloadDir, `edge-${id}.crx`);
            fs.writeFileSync(crxFile, buf);
            return await this.installFromPackage(crxFile);
        } catch (e: any) {
            const name = meta?.name ? ` (${meta.name})` : "";
            return { ok: false, error: `Edge Add-ons${name}: ${String(e?.message || e)}` };
        }
    }

    async uninstall(id: string): Promise<void> {
        const ext = this.extensions.find((e) => e.id === id);
        if (ext?.electronId) {
            try {
                remoteSession()?.removeExtension(ext.electronId);
            } catch {}
        }
        this.extensions = this.extensions.filter((e) => e.id !== id);
        await this.persist();
    }

    async setEnabled(id: string, enabled: boolean): Promise<void> {
        const ext = this.extensions.find((e) => e.id === id);
        if (!ext) return;
        ext.enabled = enabled;
        // 原生优先：启用时重新 loadExtension，停用时从 session 移除
        const ses = remoteSession();
        try {
            if (enabled) {
                if (ses) {
                    const info = await ses.loadExtension(ext.path, { allowFileAccess: true });
                    ext.native = true;
                    ext.electronId = info.id;
                    ext.nativeError = undefined;
                }
            } else if (ext.native && ext.electronId) {
                ses?.removeExtension(ext.electronId);
                ext.native = false;
                ext.nativeError = undefined;
            }
        } catch (e: any) {
            ext.native = false;
            ext.nativeError = String(e?.message || e);
        }
        await this.persist();
    }

    /**
     * 向 webview 注入所有匹配的扩展内容脚本（dom-ready 时由 WebviewController 调用）。
     * 同步触发、内部异步执行，不阻塞页面。
     */
    inject(webview: IWebviewTag, url: string): void {
        if (!this.loaded) return;
        for (const ext of this.extensions) {
            if (!ext.enabled) continue;
            if (ext.native) continue; // 原生扩展由 Chromium 自行注入（含隔离世界），垫片跳过
            const matched = ext.contentScripts.filter((cs) =>
                (cs.matches || []).some((p) => matchesUrlPattern(p, url))
            );
            if (matched.length === 0) continue;
            this.injectExtension(webview, ext, matched).catch((e) => {
                console.warn(`[browser-plugin] inject extension "${ext.name}" failed:`, e);
            });
        }
    }

    private async injectExtension(
        webview: IWebviewTag,
        ext: IInstalledExtension,
        matched: IInstalledExtension["contentScripts"]
    ): Promise<void> {
        // 1. CSS
        for (const cs of matched) {
            for (const cssFile of cs.css || []) {
                try {
                    const css = this.readFileCached(ext.path, cssFile);
                    await (webview as any).insertCSS(css);
                } catch (e) {
                    console.warn(`[browser-plugin] ext css ${cssFile} failed:`, e);
                }
            }
        }
        // 2. chrome.* 垫片 + JS（按顺序执行）
        const shim = this.buildChromeShim(ext);
        await webview.executeJavaScript(shim);
        for (const cs of matched) {
            for (const jsFile of cs.js || []) {
                try {
                    const code = this.readFileCached(ext.path, jsFile);
                    await webview.executeJavaScript(code);
                } catch (e) {
                    console.warn(`[browser-plugin] ext js ${jsFile} failed:`, e);
                }
            }
        }
    }

    /** 构建单个扩展的 chrome.* API 垫片脚本 */
    private buildChromeShim(ext: IInstalledExtension): string {
        // 读取 i18n 消息（default_locale 或 en），读取失败留空
        let messages: Record<string, any> = {};
        try {
            const locales = [ext.defaultLocale, "en", "zh_CN"].filter(Boolean);
            for (const locale of locales) {
                try {
                    messages = JSON.parse(this.readFileCached(ext.path, `_locales/${locale}/messages.json`));
                    break;
                } catch {}
            }
        } catch {}
        const manifestJson = JSON.stringify({
            manifest_version: ext.manifestVersion,
            name: ext.name,
            version: ext.version,
            description: ext.description,
            default_locale: ext.defaultLocale,
        });
        const messagesJson = JSON.stringify(messages);
        return `
(function() {
    var EXT = ${JSON.stringify({ id: ext.id, name: ext.name, path: ext.path })};
    window.chrome = window.chrome || {};
    var chrome_ = window.chrome;
    chrome_.__syBrowserExtensions = chrome_.__syBrowserExtensions || {};
    if (chrome_.__syBrowserExtensions[EXT.id]) return;
    chrome_.__syBrowserExtensions[EXT.id] = true;

    // runtime
    var messageListeners = [];
    chrome_.runtime = {
        id: EXT.id,
        getManifest: function() { return ${manifestJson}; },
        getURL: function(p) { return "chrome-extension://" + EXT.id + "/" + String(p || "").replace(/^\\//, ""); },
        onMessage: {
            addListener: function(fn) { messageListeners.push(fn); },
            removeListener: function(fn) { messageListeners = messageListeners.filter(function(f) { return f !== fn; }); },
        },
        sendMessage: function(msg, cb) {
            // background 未执行：无接收方
            if (typeof cb === "function") { try { cb(undefined); } catch (e) {} }
            return Promise.resolve(undefined);
        },
        connect: function() {
            return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} };
        },
    };

    // i18n
    var MESSAGES = ${messagesJson};
    chrome_.i18n = chrome_.i18n || {};
    chrome_.i18n.getMessage = function(key, args) {
        var entry = MESSAGES[key];
        var msg = entry ? (entry.message || "") : "";
        if (msg && args != null) {
            var arr = Array.isArray(args) ? args : [args];
            msg = msg.replace(/\\$(\\d+)/g, function(m, i) { return arr[Number(i) - 1] != null ? arr[Number(i) - 1] : m; });
        }
        return msg;
    };
    chrome_.i18n.getUILanguage = function() { return navigator.language; };

    // storage：local/sync 用 localStorage 持久化（随 partition 保留）
    function storageArea(ns) {
        var key = "__syExtStorage_" + ns + "_" + EXT.id;
        function read() {
            try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { return {}; }
        }
        function write(data) {
            try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
        }
        function normalizeKeys(keys, data) {
            var out = {};
            if (keys == null) { out = data; }
            else if (typeof keys === "string") { out[keys] = data[keys]; }
            else if (Array.isArray(keys)) { keys.forEach(function(k) { out[k] = data[k]; }); }
            else { for (var k in keys) { out[k] = (k in data) ? data[k] : keys[k]; } }
            return out;
        }
        return {
            get: function(keys, cb) {
                var out = normalizeKeys(keys, read());
                if (typeof cb === "function") { try { cb(out); } catch (e) {} }
                return Promise.resolve(out);
            },
            set: function(items, cb) {
                var data = read();
                for (var k in items) { data[k] = items[k]; }
                write(data);
                if (typeof cb === "function") { try { cb(); } catch (e) {} }
                return Promise.resolve();
            },
            remove: function(keys, cb) {
                var data = read();
                (Array.isArray(keys) ? keys : [keys]).forEach(function(k) { delete data[k]; });
                write(data);
                if (typeof cb === "function") { try { cb(); } catch (e) {} }
                return Promise.resolve();
            },
            clear: function(cb) {
                write({});
                if (typeof cb === "function") { try { cb(); } catch (e) {} }
                return Promise.resolve();
            },
        };
    }
    chrome_.storage = chrome_.storage || {};
    if (!chrome_.storage.local) chrome_.storage.local = storageArea("local");
    if (!chrome_.storage.sync) chrome_.storage.sync = storageArea("sync");
    chrome_.storage.session = chrome_.storage.session || storageArea("session");
})();
`;
    }

    /** 通过系统对话框选择扩展目录（远程内核模式降级为输入路径） */
    async pickExtensionDirectory(title: string): Promise<string | null> {
        const { ipcRenderer } = nodeModules();
        if (ipcRenderer?.invoke) {
            try {
                const result = await ipcRenderer.invoke("siyuan-get", {
                    cmd: "showOpenDialog",
                    title,
                    properties: ["openDirectory"],
                });
                if (result && !result.canceled && result.filePaths?.length) {
                    return result.filePaths[0];
                }
                if (result && !result.canceled) return null;
                // remote 模式下被拒（canceled=true 但无路径），走输入框兜底
            } catch (e) {
                console.warn("[browser-plugin] showOpenDialog failed:", e);
            }
        }
        return null;
    }

    /** 通过系统对话框选择扩展包文件（CRX / ZIP），远程内核模式返回 null 降级为输入路径 */
    async pickExtensionFile(title: string): Promise<string | null> {
        const { ipcRenderer } = nodeModules();
        if (ipcRenderer?.invoke) {
            try {
                const result = await ipcRenderer.invoke("siyuan-get", {
                    cmd: "showOpenDialog",
                    title,
                    properties: ["openFile"],
                    filters: [{ name: "Chrome Extension", extensions: ["crx", "zip"] }],
                });
                if (result && !result.canceled && result.filePaths?.length) {
                    return result.filePaths[0];
                }
                if (result && !result.canceled) return null;
            } catch (e) {
                console.warn("[browser-plugin] showOpenDialog failed:", e);
            }
        }
        return null;
    }

    /** 在插件浏览器中打开 Edge 加载项商店（浏览扩展，详情页点"安装到思源"即可安装） */
    openEdgeStore(): void {
        const plugin = (window as any).browserPlugin;
        if (plugin?.openUrl) {
            plugin.openUrl(EDGE_ADDONS_HOME);
        } else {
            window.open(EDGE_ADDONS_HOME, "_blank");
        }
    }

    // ===== 内容脚本 chrome.* 真实绑定（cs-runtime.ts 的宿主能力提供者） =====

    private csRuntimeInited = false;

    private initCsRuntimeOnce(): void {
        if (this.csRuntimeInited) return;
        initCsRuntime({
            listNativeExts: () =>
                this.extensions
                    .filter((e) => e.enabled && e.native && !!e.electronId)
                    .map((e) => ({
                        electronId: e.electronId!,
                        path: e.path,
                        name: e.name,
                        version: e.version,
                        defaultLocale: e.defaultLocale,
                        contentScripts: e.contentScripts,
                    })),
            readFile: (extPath: string, rel: string) => {
                const { fs, path } = nodeModules();
                return fs.readFileSync(path.join(extPath, rel), "utf8");
            },
            messages: (extPath: string, defaultLocale: string) => {
                for (const locale of [defaultLocale, "en", "zh_CN"].filter(Boolean)) {
                    try {
                        return JSON.parse(this.readFileCached(extPath, `_locales/${locale}/messages.json`));
                    } catch {}
                }
                return {};
            },
            wakeOne: async (electronId: string) => {
                const ses = remoteSession();
                if (!ses) return null;
                const ext = this.extensions.find((e) => e.electronId === electronId);
                if (!ext) return null;
                try {
                    ses.removeExtension(electronId);
                } catch {}
                try {
                    const info = await ses.loadExtension(ext.path, { allowFileAccess: true });
                    if (info?.id && info.id !== electronId) {
                        // Electron 的扩展 id 与 SW origin 可能跨 load 变化 —— 同步回列表
                        ext.electronId = info.id;
                        ext.native = true;
                        await this.persist();
                        return info.id;
                    }
                    return electronId;
                } catch {
                    return null;
                }
            },
            wakeSw: async (electronId: string) => {
                await this.wakeSw(electronId);
            },
        });
        this.csRuntimeInited = true;
    }

    /** 无副作用唤醒扩展 SW（startWorkerForScope 只启动 SW，不卸载扩展）：
     *  remove+load 会销毁正在打开的扩展面板 isolated world（binding 失效），
     *  面板打开前的预热必须走这里。失败（扩展未加载等）静默回退 remove+load。 */
    async wakeSw(electronId: string): Promise<void> {
        const ses = remoteSession();
        if (!ses) return;
        try {
            await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${electronId}/`);
            return;
        } catch {}
        const ext = this.extensions.find((e) => e.electronId === electronId);
        if (!ext) return;
        try { ses.removeExtension(electronId); } catch {}
        try { await ses.loadExtension(ext.path, { allowFileAccess: true }); } catch {}
    }

    /** dom-ready 时调用：确保该页签的 CDP 会话与各扩展自建世界就绪 */
    ensureCsRuntime(webview: IWebviewTag): void {
        try {
            this.initCsRuntimeOnce();
            ensureCsRuntime(webview);
        } catch (e) {
            console.warn("[browser-plugin] ensureCsRuntime failed:", e);
        }
    }

    disposeCsRuntime(webview: IWebviewTag): void {
        try {
            disposeCsRuntime(webview);
        } catch {}
    }

    /** 扩展管理对话框 */
    openManager(i18n: Record<string, string>): void {
        const dialog = new Dialog({
            title: i18n.extManager || "Chrome 扩展",
            content: `<div class="sy-ext-manager" style="padding:16px;"></div>`,
            width: "620px",
        });
        const container = dialog.element.querySelector(".sy-ext-manager") as HTMLElement;
        const render = () => {
            container.innerHTML = "";
            const hint = document.createElement("div");
            hint.style.cssText = "font-size:12px;color:var(--b3-theme-on-surface-light);margin-bottom:8px;line-height:1.6;";
            hint.textContent = i18n.extHint || "支持安装未打包的 Chrome 扩展目录（manifest.json）或 CRX / ZIP 扩展包。内容脚本将注入到所有浏览器页签；扩展的 background/popup 不执行，部分扩展可能无法完整工作。安装后刷新页签生效。";
            container.appendChild(hint);

            const toolbar = document.createElement("div");
            toolbar.style.cssText = "display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;";
            const pickBtn = document.createElement("button");
            pickBtn.className = "b3-button";
            pickBtn.textContent = i18n.extPickFolder || "选择扩展目录安装...";
            pickBtn.addEventListener("click", async () => {
                const dir = await this.pickExtensionDirectory(i18n.extManager || "Chrome 扩展");
                if (!dir) return;
                const r = await this.installFromInput(dir);
                if (r.ok) {
                    showMessage((i18n.extInstalled || "已安装扩展") + ": " + r.ext!.name, 3000, "info");
                    render();
                } else {
                    showMessage((i18n.extInstallFailed || "安装扩展失败") + ": " + r.error, 5000, "error");
                }
            });
            toolbar.appendChild(pickBtn);

            const pickFileBtn = document.createElement("button");
            pickFileBtn.className = "b3-button";
            pickFileBtn.textContent = i18n.extPickCrx || "安装 CRX / ZIP 包...";
            pickFileBtn.addEventListener("click", async () => {
                const file = await this.pickExtensionFile(i18n.extManager || "Chrome 扩展");
                if (!file) return;
                const r = await this.installFromPackage(file);
                if (r.ok) {
                    showMessage((i18n.extInstalled || "已安装扩展") + ": " + r.ext!.name, 3000, "info");
                    render();
                } else {
                    showMessage((i18n.extInstallFailed || "安装扩展失败") + ": " + r.error, 5000, "error");
                }
            });
            toolbar.appendChild(pickFileBtn);

            // 手动输入路径安装（远程内核/对话框不可用时）：目录按目录装，CRX/ZIP 文件解压安装
            const input = document.createElement("input");
            input.className = "b3-text-field";
            input.style.flex = "1";
            input.style.minWidth = "200px";
            input.placeholder = "C:\\path\\to\\extension.crx 或 /path/to/extension 目录";
            toolbar.appendChild(input);
            const manualBtn = document.createElement("button");
            manualBtn.className = "b3-button";
            manualBtn.textContent = i18n.extInstallPath || "按路径安装";
            manualBtn.addEventListener("click", async () => {
                const p = input.value.trim();
                if (!p) return;
                const r = await this.installFromInput(p);
                if (r.ok) {
                    showMessage((i18n.extInstalled || "已安装扩展") + ": " + r.ext!.name, 3000, "info");
                    render();
                } else {
                    showMessage((i18n.extInstallFailed || "安装扩展失败") + ": " + r.error, 5000, "error");
                }
            });
            toolbar.appendChild(manualBtn);
            container.appendChild(toolbar);

            // Edge 加载项商店安装行：粘贴详情页链接或扩展 ID 直接下载安装
            const edgeToolbar = document.createElement("div");
            edgeToolbar.style.cssText = "display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;";
            const edgeInput = document.createElement("input");
            edgeInput.className = "b3-text-field";
            edgeInput.style.flex = "1";
            edgeInput.style.minWidth = "240px";
            edgeInput.placeholder =
                i18n.extEdgePlaceholder ||
                "https://microsoftedge.microsoft.com/addons/detail/... 或扩展 ID";
            edgeInput.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") {
                    edgeBtn.click();
                }
            });
            edgeToolbar.appendChild(edgeInput);
            const edgeBtn = document.createElement("button");
            edgeBtn.className = "b3-button";
            edgeBtn.textContent = i18n.extEdgeInstall || "从 Edge 加载项安装";
            edgeBtn.addEventListener("click", async () => {
                const v = edgeInput.value.trim();
                if (!v) {
                    edgeInput.focus();
                    return;
                }
                edgeBtn.disabled = true;
                const originalText = edgeBtn.textContent;
                edgeBtn.textContent = i18n.extEdgeDownloading || "下载中...";
                try {
                    const r = await this.installFromEdgeAddons(v);
                    if (r.ok) {
                        edgeInput.value = "";
                        showMessage((i18n.extInstalled || "已安装扩展") + ": " + r.ext!.name, 3000, "info");
                        render();
                    } else {
                        showMessage((i18n.extInstallFailed || "安装扩展失败") + ": " + r.error, 6000, "error");
                    }
                } finally {
                    edgeBtn.disabled = false;
                    edgeBtn.textContent = originalText;
                }
            });
            edgeToolbar.appendChild(edgeBtn);
            // 打开商店：在插件浏览器里浏览扩展，详情页点"安装到思源"直接安装
            const openStoreBtn = document.createElement("button");
            openStoreBtn.className = "b3-button b3-button--cancel";
            openStoreBtn.textContent = i18n.extOpenStore || "打开 Edge 加载项商店";
            openStoreBtn.addEventListener("click", () => this.openEdgeStore());
            edgeToolbar.appendChild(openStoreBtn);
            container.appendChild(edgeToolbar);

            const list = this.list();
            if (list.length === 0) {
                const empty = document.createElement("div");
                empty.style.cssText = "text-align:center;padding:24px;color:var(--b3-theme-on-surface-light);";
                empty.textContent = i18n.extEmpty || "尚未安装扩展";
                container.appendChild(empty);
            }
            for (const ext of list) {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--b3-border-color);";
                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.className = "b3-switch";
                cb.checked = ext.enabled;
                cb.title = i18n.extEnabled || "启用";
                cb.addEventListener("change", async () => {
                    await this.setEnabled(ext.id, cb.checked);
                });
                row.appendChild(cb);
                const info = document.createElement("div");
                info.style.cssText = "flex:1;min-width:0;";
                info.innerHTML =
                    `<div style="font-weight:500;">${escapeHtml(ext.name)} <span style="color:var(--b3-theme-on-surface-light);font-size:12px;">v${escapeHtml(ext.version)} · MV${ext.manifestVersion}</span>` +
                    (ext.native
                        ? ` <span title="${escapeHtml(i18n.extNativeTip || "Electron 原生扩展运行时")}（${escapeHtml(ext.electronId || "")}）" style="color:var(--b3-theme-primary,#3575f0);font-size:12px;">● ${escapeHtml(i18n.extNative || "原生")}</span>`
                        : ` <span title="${escapeHtml(ext.nativeError || i18n.extShimTip || "chrome.* 垫片模拟")}（${escapeHtml(i18n.extShim || "垫片")}）" style="color:var(--b3-theme-on-surface-light);font-size:12px;">○ ${escapeHtml(i18n.extShim || "垫片")}</span>`) +
                    (ext.hasBackground && !ext.native
                        ? ` <span title="${escapeHtml(i18n.extBackgroundWarn || "依赖 background，本宿主不执行，可能无效")}" style="color:var(--b3-theme-warning,#d97706);font-size:12px;">⚠ background</span>`
                        : "") +
                    `</div>` +
                    `<div style="font-size:12px;color:var(--b3-theme-on-surface-light);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(ext.path)}">${escapeHtml(ext.path)}</div>` +
                    (ext.nativeError
                        ? `<div style="font-size:12px;color:var(--b3-theme-error,#d23f31);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(ext.nativeError)}">${escapeHtml(ext.nativeError)}</div>`
                        : "");
                row.appendChild(info);
                const delBtn = document.createElement("button");
                delBtn.className = "b3-button b3-button--cancel";
                delBtn.textContent = i18n.delete || "删除";
                delBtn.addEventListener("click", async () => {
                    await this.uninstall(ext.id);
                    render();
                });
                row.appendChild(delBtn);
                container.appendChild(row);
            }
        };
        render();
    }
}

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * 从 manifest 取工具栏图标路径。
 * icons 可以是 {"16": "...", "48": "...", "128": "..."} 这种尺寸映射，
 * 也可能是数组（旧格式）或直接字符串。取声明的最大尺寸，缩放前细节最好。
 */
function pickLargestIcon(manifest: any): string | undefined {
    const icons = manifest?.icons || manifest?.action?.default_icon
        || manifest?.browser_action?.default_icon || manifest?.page_action?.default_icon;
    if (!icons) return undefined;
    if (typeof icons === "string") return icons;
    if (Array.isArray(icons)) return icons.length ? String(icons[icons.length - 1]) : undefined;
    if (typeof icons !== "object") return undefined;
    const sizes = Object.keys(icons)
        .map((k) => parseInt(k, 10))
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => b - a);
    return sizes.length ? String(icons[String(sizes[0])]) : undefined;
}
