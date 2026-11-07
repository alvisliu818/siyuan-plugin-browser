import { Dialog, showMessage } from "siyuan";
import type { IWebviewTag } from "../types";
import { parseExtensionPackage } from "./crx";
import { EDGE_ADDONS_HOME, downloadEdgeCrxWithFallback, fetchEdgeAddonMeta, parseEdgeAddonId } from "./edgeStore";
import { disposeCsRuntime, ensureCsRuntime, initCsRuntime, seedExtensionKernelSettings } from "./cs-runtime";
import { remoteSession } from "../utils/electron";
import { UserscriptInjector } from "./userscriptInjector";

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
    /** manifest.chrome_url_overrides.newtab（新标签页扩展：可设为新页签默认页） */
    newtabPath?: string;
    /** manifest.options_ui/options_page（openOptionsPage 打开的目标页） */
    optionsPath?: string;
}

const EXTENSIONS_KEY = "extensions.json";

/** 快速安装入口：Edge 加载项商店的常用扩展 id（油猴等） */
const QUICK_INSTALL_EDGE: Array<{ id: string; label: string }> = [
    { id: "iikmkjmpaadaobahmlepeloendndfphd", label: "油猴 (Tampermonkey)" },
];

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
    /** chrome.userScripts 适配层（宿主侧：注册表副本 + 页面注入） */
    usInjector = new UserscriptInjector();

    constructor(plugin: any) {
        this.plugin = plugin;
        // manager 与页面无关，构造即就绪（popup 可在 about:blank 等非 http 页上打开）
        this.initCsRuntimeOnce();
        // 原生扩展信息的惰性供给（userScripts 注册表按扩展隔离、世界按需创建）
        this.usInjector.setNativeIdProvider(() =>
            this.extensions
                .filter((e) => e.enabled && e.native && !!e.electronId)
                .map((e) => ({
                    electronId: e.electronId!,
                    path: e.path,
                    name: e.name,
                    version: e.version,
                    defaultLocale: e.defaultLocale,
                    contentScripts: e.contentScripts,
                    // 内容世界 tab 身份（真 Chrome sender.tab 语义，见 ICsExtInfo）
                    senderTabId: 1,
                }))
        );
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
        // v23：userScripts.execute 补桩（SW→页面 下发用户脚本代码，出箱
        //       __syUsExecOutbox 由 cs-runtime 回包泵排空后在自建世界执行）——
        //       Violentmonkey MV3 注入链 forceContent 路径的关键通道。
        // v22：tabs.get/update 原生存在也包装（get 失败兜底假 tab；update 带 url
        //       写出箱）——VM .user.js 安装链 confirmInstall 的 getTab+tabs.update
        //       被原生实现卡死，confirm 页永不出现。
        // v21：+ 0f 事件面补全（notifications/download 等命名空间"有对象无事件"，
        //       VM sw.js 顶层 browser.notifications.onClicked.addListener TypeError）。
        // v20：chrome.extension 兼容（0e 节，Violentmonkey SW 启动即死修复）。
        // v19：TM extdb 启动守卫（脚本主库后端锚定 + 镜像回填，见 0d 节注释）。
        // 尾标记 sy-bg-shim-end 用于换版时从旧文件剥离旧垫片；无尾标记的旧文件
        // 走"守卫幂等堆叠"（各节都有 __sy* 守卫，双跑无害）。
        // 标记含内容哈希（见 shimBody 之后）：迭代垫片内容而版本号不变时也能
        // 触发重注入，杜绝"改了垫片但文件头标记没变被跳过"的坑。
        const SHIM_VER = "v23";
        let changedShimCount = 0;
        // shimBody/SHIM_MARK 提到循环外：catch 重试块也要用（原来定义在 try 内，
        // 重试块 TS2304 + 运行时 ReferenceError——文件锁场景重试永远失败）。
        // shimBody 是静态模板，不依赖循环变量。
        const shimBody = `
;(function () {
    try {
        if (typeof chrome === "undefined") return;
        // 0) onMessage handlers 收集数组：无条件最顶部创建 —— background 顶层的
        //    addListener 稍后 push 进同一数组；宿主 routeSendMessage 据此判断
        //    "handler 已注册（非空）" 还是 "仍在启动期（空 → 重试）"。
        //    （此前数组在 onMessage 包装内创建，若包装条件不满足则数组缺失，
        //    宿主会误报 "垫片未运行" 且无重试依据。）
        self.__syOnMessageHandlers = self.__syOnMessageHandlers || [];
        // 0b) 消息归一（垫片统一兼容点）：SW 侧部分扩展 handler 对可选字段无
        //     保护（实测 TM loadTree：referrer 缺失 → pd.level(undefined) 抛
        //     "Cannot read properties of undefined (reading 'replace')" →
        //     options 页引导走 fail → 原生 confirm 同步阻塞 JS 线程，页面假死
        //     并弹 "An internal error occurred"）。宿主的三条消息路由
        //     （CS→SW sendMessage / port 派发 / storage onChanged 回程）都经
        //     此归一，兼容逻辑只住这一处。
        self.__syNormalizeMsg = function (msg) {
            try {
                if (msg && typeof msg === "object") {
                    if (msg.method === "loadTree" && msg.referrer === undefined) {
                        msg = Object.assign({}, msg, { referrer: (typeof msg.origin === "string" && msg.origin) || "options" });
                    }
                }
            } catch (e) {}
            return msg;
        };
        // 0b2) fetch 预取钩子（暴力猴安装提速）：宿主在拦截 .user.js 导航后把
        //     脚本内容写进 __syPrefetched[uri]（分区 session 直取 + 镜像，比 VM
        //     SW 自身的 fetch 快且稳），这里包一层 fetch —— VM 拉取脚本时命中
        //     预取即本地 Response 秒回，原生安装链（解析→confirm 页）照常跑，
        //     只是去掉了最慢的一环。映射为空时透传原生 fetch，其他扩展零影响。
        if (!self.__syFetchPrefetchWrapped && typeof self.fetch === "function") {
            self.__syFetchPrefetchWrapped = true;
            self.__syPrefetched = self.__syPrefetched || {};
            var syOrigFetch = self.fetch.bind(self);
            self.fetch = function (input, init) {
                try {
                    var u = typeof input === "string" ? input : (input && input.url) || "";
                    if (u && self.__syPrefetched && self.__syPrefetched[u]) {
                        var body = self.__syPrefetched[u];
                        delete self.__syPrefetched[u];
                        return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/javascript; charset=utf-8" } }));
                    }
                } catch (e) {}
                return syOrigFetch(input, init);
            };
        }
        // 0c) onInstalled 收集 + 真首次放行：Electron 每次 loadExtension（含本
        //     插件启动时的 removeExtension+loadExtension 保活/重载）都以
        //     reason=install 派发 onInstalled —— 实测 TM 据此每次启动都开
        //     tampermonkey.net/installed.php 欢迎页签（旧 tabs.create 假桩静默
        //     吞掉所以从未暴露，create 实装后每个 SW 启动都弹页签）。属性替换后
        //     原生事件落到无监听的原生对象上自然被吞；是否放行改由 storage
        //     持久标记决定（按扩展隔离，真·首次安装语义）。
        try {
            if (chrome.runtime && chrome.runtime.onInstalled && !chrome.runtime.onInstalled.__syWrapped) {
                var oiFns = [];
                var oiWrapped = {
                    addListener: function (fn) { if (typeof fn === "function") oiFns.push(fn); },
                    removeListener: function (fn) { var i = oiFns.indexOf(fn); if (i >= 0) oiFns.splice(i, 1); },
                };
                oiWrapped.__syWrapped = true;
                try { Object.defineProperty(chrome.runtime, "onInstalled", { configurable: true, get: function () { return oiWrapped; } }); } catch (eOi) { try { chrome.runtime.onInstalled = oiWrapped; } catch (eOi2) {} }
                var oiEmit = function (details) { for (var i = 0; i < oiFns.length; i++) { try { oiFns[i](details); } catch (eOi3) {} } };
                oiWrapped.__syEmit = oiEmit;
                try {
                    chrome.storage.local.get(["__syOiSeen"], function (v) {
                        if (v && v.__syOiSeen) return;
                        try { chrome.storage.local.set({ __syOiSeen: Date.now() }, function () {}); } catch (eOi4) {}
                        oiEmit({ reason: "install" });
                    });
                } catch (eOi5) {}
            }
        } catch (e) {}
        // 0d) TM extdb 启动守卫：TM 5.5 的脚本主库按 "#storage" 类型标记在两个
        //     持久后端之间二选一 —— chrome.storage.local（"!extdb.*" 键）与
        //     IndexedDB("ext","general")，默认 storage.local，读不到标记时即落它。
        //     本环境实测：扩展重载/clearStorageData(serviceworkers) 会连带清空
        //     扩展 origin 的 IndexedDB（脚本库丢失事故），而 chrome.storage 键
        //     幸存 —— 必须确保 TM 启动锚定在 storage.local，且 IndexedDB 路径
        //     也能看见脚本（双保险）：
        //     1) 在途拦截 chrome.storage.local.get：结果里 "!extdb.#storage" 若为
        //        "indexedDB" 就地改写 "storage.local"（回调内同步改写，TM 的
        //        后端选择读到即生效，无竞态窗口），并异步落盘修正（一次性）；
        //     2) 镜像 → IndexedDB 兜底回填：镜像有 @uid# 条目而 IndexedDB 没有
        //        任何 @uid# 键时，剥 "!extdb." 前缀与 {origin,value} 包装写回
        //        （IndexedDB 已有脚本时不回填，防旧镜像覆盖新数据）。
        //     启动诊断快照落 self.__syExtDbBoot 供宿主探针读取。
        try {
            if (!self.__syExtDbGuard) {
                self.__syExtDbGuard = true;
                var EXTDB_PFX = "!extdb.", EXTDB_TYPE = "!extdb.#storage";
                var stLocal = chrome.storage.local;
                var extDbDiag = self.__syExtDbBoot = { ts: Date.now(), markerRewritten: 0, backfilled: 0 };
                try {
                    if (stLocal && typeof stLocal.get === "function" && !stLocal.__syExtDbGet) {
                        var origGet = stLocal.get.bind(stLocal);
                        var fixResult = function (res) {
                            try {
                                var t = res && res[EXTDB_TYPE];
                                var tv = t && typeof t === "object" && "value" in t ? t.value : t;
                                if (tv === "indexedDB") {
                                    var wrapped = t && typeof t === "object" && "value" in t;
                                    if (wrapped) t.value = "storage.local"; else res[EXTDB_TYPE] = "storage.local";
                                    extDbDiag.markerRewritten++;
                                    if (!extDbDiag.markerPersisted) {
                                        extDbDiag.markerPersisted = true;
                                        var fix = {};
                                        fix[EXTDB_TYPE] = wrapped ? { origin: (t && t.origin) || "normal", value: "storage.local" } : { origin: "normal", value: "storage.local" };
                                        try { stLocal.set(fix, function () {}); } catch (eF2) {}
                                    }
                                }
                            } catch (eF) {}
                            return res;
                        };
                        stLocal.get = function (keys, cb) {
                            if (typeof keys === "function") {
                                var cb1 = keys; keys = null;
                                return origGet(null, function (v) { try { cb1(fixResult(v)); } catch (e1) { cb1(v); } });
                            }
                            if (typeof cb === "function") return origGet(keys, function (v) { try { cb(fixResult(v)); } catch (e2) { cb(v); } });
                            var p = origGet(keys, null);
                            try { if (p && typeof p.then === "function") p = p.then(fixResult); } catch (e3) {}
                            return p;
                        };
                        stLocal.__syExtDbGet = true;
                    }
                } catch (eG) { extDbDiag.getWrapErr = String(eG); }
                try {
                    stLocal.get(null, function (all) {
                        try {
                            var uidN = 0, extN = 0;
                            for (var k in all) {
                                if (k.indexOf(EXTDB_PFX) !== 0) continue;
                                extN++;
                                if (k.indexOf(EXTDB_PFX + "@uid#") === 0) uidN++;
                            }
                            extDbDiag.nMirrorExt = extN;
                            extDbDiag.nMirrorUid = uidN;
                            if (!uidN) return;
                            var rq = indexedDB.open("ext", 1);
                            rq.onupgradeneeded = function (ev) { try { var d = ev.target.result; if (!d.objectStoreNames.contains("general")) d.createObjectStore("general"); } catch (eU) {} };
                            rq.onsuccess = function () {
                                var db = rq.result;
                                try {
                                    var tx = db.transaction("general", "readonly");
                                    var gk = tx.objectStore("general").getAllKeys();
                                    gk.onsuccess = function () {
                                        try {
                                            var hasUid = false, i;
                                            for (i = 0; i < gk.result.length; i++) { if (String(gk.result[i]).indexOf("@uid#") === 0) { hasUid = true; break; } }
                                            extDbDiag.idbKeys = gk.result.length;
                                            if (hasUid) return;
                                            var tx2 = db.transaction("general", "readwrite");
                                            var os = tx2.objectStore("general");
                                            var n = 0;
                                            for (var k3 in all) {
                                                if (k3.indexOf(EXTDB_PFX) !== 0) continue;
                                                var v = all[k3];
                                                if (v && typeof v === "object" && "value" in v) v = v.value;
                                                try { os.put(v, k3.slice(EXTDB_PFX.length)); n++; } catch (eP) {}
                                            }
                                            extDbDiag.backfilled = n;
                                        } catch (eS) { extDbDiag.backfillErr = String(eS); }
                                    };
                                    gk.onerror = function () { extDbDiag.backfillErr = "getAllKeys failed"; };
                                } catch (eT) { extDbDiag.backfillErr = String(eT); }
                            };
                            rq.onerror = function () { extDbDiag.backfillErr = "idb open failed"; };
                        } catch (eA) { extDbDiag.backfillErr = String(eA); }
                    });
                } catch (eB) {}
            }
        } catch (e) {}
        // 0e) chrome.extension 兼容（v20，Violentmonkey SW 启动即死修复）：VM 2.50
        //     的 sw.js 顶层 probe chrome.extension.isAllowedFileSchemeAccess /
        //     isAllowedIncognitoAccess（真实 SW 实证报
        //     "O.extension.isAllowedIncognitoAccess is not a function" → 顶层
        //     TypeError → SW 启动即死、has_started_service_worker 恒 false →
        //     popup 的 OpenDashboard 等消息全部路由到死 SW，设置/加号按钮无反应）。
        //     Electron 的 chrome.extension 命名空间存在但缺这两个方法 —— 补
        //     回调+Promise 双语义桩（能力探测语义：无 incognito/文件访问回 false
        //     即可让扩展初始化走完）。
        try {
            if (typeof chrome.extension === "undefined") { try { chrome.extension = {}; } catch (eXt0) {} }
            if (chrome.extension && typeof chrome.extension.isAllowedFileSchemeAccess !== "function") {
                chrome.extension.isAllowedFileSchemeAccess = function (cb) { try { if (typeof cb === "function") cb(false); } catch (eXt1) {} return Promise.resolve(false); };
            }
            if (chrome.extension && typeof chrome.extension.isAllowedIncognitoAccess !== "function") {
                chrome.extension.isAllowedIncognitoAccess = function (cb) { try { if (typeof cb === "function") cb(false); } catch (eXt2) {} return Promise.resolve(false); };
            }
        } catch (e) {}
        // 0f) 事件面补全（v21）：求值期实测 chrome.notifications 等**整体缺失**
        //     （mutProbe 实证：undefined，非"有对象无事件"）——第 1 节的通用壳
        //     只带 5 个泛型事件（onChanged/onClicked/onCommand/onInstalled/
        //     onStartup），缺 VM sw.js 顶层要用的 onClosed/onShown 等 →
        //     browser.notifications.onClosed.addListener 直接 TypeError（SW 启动
        //     即死第二幕）。本节按命名空间补完整事件面：命名空间缺失则建壳，
        //     已存在则只补缺失的事件壳。
        try {
            var syMkEvent = function () {
                var fns = [];
                return {
                    addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                    removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                    hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
                };
            };
            var syCloneNs = function (ns, name, ev) {
                var merged = {};
                try {
                    var names = Object.getOwnPropertyNames(ns);
                    for (var iK = 0; iK < names.length; iK++) {
                        try {
                            var d = Object.getOwnPropertyDescriptor(ns, names[iK]);
                            if (d && d.get) Object.defineProperty(merged, names[iK], d);
                            else if (d) { d.configurable = true; Object.defineProperty(merged, names[iK], d); }
                        } catch (eC1) {}
                    }
                } catch (eC2) {}
                merged[name] = ev;
                return merged;
            };
            var syEnsureEvent = function (parent, childKey, name) {
                if (!parent) return;
                var ns = parent[childKey];
                if (!ns || typeof ns !== "object" && typeof ns !== "function") {
                    try { parent[childKey] = {}; } catch (eNs) { return; }
                    ns = parent[childKey];
                }
                var cur = ns[name];
                if (cur && typeof cur.addListener === "function") return;
                var ev = syMkEvent();
                try { Object.defineProperty(ns, name, { configurable: true, get: function () { return ev; } }); } catch (eA) {}
                if (ns[name] && typeof ns[name].addListener === "function") return;
                try { ns[name] = ev; } catch (eB) {}
                if (ns[name] && typeof ns[name].addListener === "function") return;
                try {
                    var merged = syCloneNs(ns, name, ev);
                    try { Object.defineProperty(parent, childKey, { configurable: true, get: function () { return merged; } }); } catch (eD) { try { parent[childKey] = merged; } catch (eE) {} }
                } catch (eF) {}
            };
            var syEventFaces = [
                ["notifications", "onClicked"], ["notifications", "onClosed"], ["notifications", "onShown"],
                ["notifications", "onButtonClicked"], ["notifications", "onPermissionLevelChanged"],
                ["downloads", "onChanged"], ["downloads", "onCreated"], ["downloads", "onErased"],
                ["alarms", "onAlarm"], ["commands", "onCommand"],
                ["omnibox", "onInputStarted"], ["omnibox", "onInputChanged"], ["omnibox", "onInputEntered"], ["omnibox", "onInputCancelled"],
            ];
            for (var iEF = 0; iEF < syEventFaces.length; iEF++) {
                var face = syEventFaces[iEF];
                syEnsureEvent(chrome, face[0], face[1]);
            }
        } catch (e) {}
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
        // chrome.windows 补桩：AdGuard init 链调 WindowsApi.update → chrome.windows.*，
        // Electron SW 里 chrome.windows 缺失 → TypeError → init 中断（实测
        // 设置页 React 不挂载的直接原因）。补齐 create/update/remove/getAll/getLastFocused。
        if (!chrome.windows) {
            chrome.windows = {
                create: function (opts, cb) { var w = { id: 1 }; if (typeof cb === "function") { try { cb(w); } catch (e) {} } return Promise.resolve(w); },
                update: function (id, props, cb) { var w = { id: id }; if (typeof cb === "function") { try { cb(w); } catch (e) {} } return Promise.resolve(w); },
                remove: function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); },
                getAll: function (cb) { var v = []; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); },
                getLastFocused: function (cb) { var w = { id: 1 }; if (typeof cb === "function") { try { cb(w); } catch (e) {} } return Promise.resolve(w); },
                onCreated: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
                onRemoved: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
                onFocusChanged: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
            };
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
                                    var r = fn(self.__syNormalizeMsg ? self.__syNormalizeMsg(env.msg) : env.msg, env.sender || { id: "sy-host" }, sendResponse);
                                    if (r === true) {
                                        // handler 返回 true 表示异步 sendResponse，等待其回调
                                    } else if (r !== undefined && r !== false) {
                                        // r===false 是 Chrome 语义的"我不回包"，不作为回包值
                                        //（与 cs-runtime routeSendMessage 的同语义修正一致）
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
        // 3b) storage.managed 补桩：Electron 无 managed storage（企业策略存储）。
        //     TM 启动探测它，原生缺失抛 "managed is not available" → 重试 4 轮
        //     （每轮带延时）拖慢 SW 启动。补空桩（get 恒空对象）→ TM 立即走
        //     storage.local 分支。sync 保持原生（Electron 原生 sync 实测可用）。
        try {
            if (chrome.storage && !chrome.storage.managed) {
                chrome.storage.managed = {
                    get: function (keys, cb) {
                        var empty = {};
                        if (typeof cb === "function") { try { cb(empty); } catch (e) {} }
                        return Promise.resolve(empty);
                    },
                };
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
        // 5-pre) tabs.query 过滤语义补全（独立节：不受 5 的 __syTabWrapped 守卫
        //    影响，旧垫片文件换版堆叠时也能生效）。Electron 原生 query 不认
        //    active/lastFocusedWindow 过滤（实测 {active,lastFocusedWindow} 恒 []），
        //    TM 的 popup 会话靠它解析"面板所属活动页签"——查空则 loadTree 无
        //    tab 上下文（面板显示 no access、脚本状态全丢）。宿主经 tabevent 喂
        //    的 tab 存 __syLastFedTab，作为活动页签并入结果，再做简化过滤。
        try {
            if (chrome.tabs && !chrome.tabs.__syQueryPatched) {
                self.__syLastFedTab = self.__syLastFedTab || null;
                var origTabsQuery = typeof chrome.tabs.query === "function" ? chrome.tabs.query.bind(chrome.tabs) : null;
                var syUrlMatch = function (pattern, url) {
                    try {
                        var m = /^(\\*|https?|file|ftp|urn):\\/\\/(\\*(?:\\.[^\\/ *]+)?|\\*|[^\\/ *]+)(\\/.*)$/.exec(pattern);
                        if (!m) return false;
                        if (!/^https?:\\/\\//i.test(url || "")) return false;
                        var u = new URL(url);
                        var scheme = u.protocol.replace(":", "");
                        if (m[1] !== "*" && m[1] !== scheme) return false;
                        var host = u.host, hostOk = m[2] === "*" || (m[2].indexOf("*.") === 0 ? host === m[2].slice(2) || host.indexOf("." + m[2].slice(2), host.length - ("." + m[2].slice(2)).length) >= 0 : host === m[2] || host === m[2].split(":")[0]);
                        if (!hostOk) return false;
                        var rx = new RegExp("^" + m[3].replace(/[.+?^{}()|[\]\\\\$]/g, "\\\\$&").replace(/\\*/g, ".*") + "$");
                        return rx.test((u.pathname || "/") + (u.search || ""));
                    } catch (e) { return false; }
                };
                chrome.tabs.query = function (props, cb) {
                    // deferred 模式：原生可能是回调式（返回 undefined）也可能是 promise
                    // 式 —— 两种都接住，promise 式调用方（await chrome.tabs.query）拿
                    // 到的恒是数组。done 守卫防回调+promise 双触发。
                    var done = false, resolveP = null;
                    var finish = function (nativeList) {
                        if (done) return;
                        done = true;
                        var list = (nativeList && nativeList.slice && nativeList.slice()) || [];
                        // 扩展自身页面（popup/options 真源 webview）不是"用户页签"：
                        // Electron 原生 query 会把扩展 popup webview 当 active 页签
                        // 返回且排最前（实测），TM getActiveTab 取第一个 → 面板把
                        // 扩展页当当前页 → getFailureReason 判 noninjectable →
                        // "cannot run userscripts"（首启实测根因）。一律剔除。
                        list = list.filter(function (t) { return !/^chrome-extension:\\/\\//i.test(t.url || ""); });
                        // 原生对同一 webview 可能返回重复条目（实测 baidu ×2）→ 去重
                        var seenTabs = {};
                        list = list.filter(function (t) { var k = String(t.id) + "|" + (t.url || ""); if (seenTabs[k]) return false; seenTabs[k] = 1; return true; });
                        var fed = self.__syLastFedTab;
                        if (fed && !list.some(function (t) { return String(t.id) === String(fed.id); })) list = list.concat([fed]);
                        var p = props || {};
                        if (p.active || p.highlighted) list = list.filter(function (t) { return t.active; });
                        if (p.windowId !== undefined && p.windowId !== -1 && p.windowId !== 1) list = list.filter(function (t) { return t.windowId === p.windowId; });
                        if (p.url) {
                            var pats = Array.isArray(p.url) ? p.url : [p.url];
                            list = list.filter(function (t) { return pats.some(function (pt) { return syUrlMatch(pt, t.url || ""); }); });
                        }
                        if (typeof cb === "function") { try { cb(list); } catch (e) {} }
                        if (resolveP) resolveP(list);
                        return list;
                    };
                    var pending = new Promise(function (res) { resolveP = res; });
                    if (origTabsQuery) {
                        try {
                            var qr = origTabsQuery(props || {}, function (v) { finish(v); });
                            if (qr && typeof qr.then === "function") {
                                return qr.then(function (v) { return finish(v); }, function () { return finish([]); });
                            }
                            // 原生纯回调式：回调已挂上，原生按契约必回调 → pending 必 resolve
                            return pending;
                        } catch (e) { /* 原生抛错走兜底 */ }
                    }
                    finish([]);
                    return pending;
                };
                chrome.tabs.__syQueryPatched = true;
            }
        } catch (e) {}
        // 5) chrome.tabs 事件收集（AdGuard 等靠 onCreated/onUpdated 维护 tabContext，
        //    Electron SW 里这些事件永不触发 → 扩展取 tab 状态时 getTabContext 恒
        //    undefined → popup 卡 loading）。宿主经 "tabevent" 通道手工喂 tab。
        try {
            if (chrome.tabs && !chrome.tabs.__syTabWrapped) {
                // 5a) tabs API 补桩：Electron 原生 tabs 缺 create/update/remove 等，
                //     AdGuard onInstalled 流程调 tabs.create 直接 TypeError →
                //     初始化链中断（tabsApi.start 永不执行 → popup 取状态卡 loading）。
                //     create **实装**：SW 无法直接开宿主页签，写内存出箱 __syTabCreateOutbox，
                //     宿主路由 sendmessage 完成后排空 → bp.openUrl 真实开页签
                //     （实测 TM popup「查找新脚本」走 SW newTab handler → tabs.create，
                //     旧假桩静默吞掉 → 无反应/空页签）。update 同样写出箱（VM MV3
                //     confirmInstall 走 tabs.update(tabId,{url:confirmUrl}) 替换当前
                //     页签打开安装确认页 —— 假桩静默吞 URL → confirm 页永不出现，
                //     .user.js 安装链 9s 回落报"未找到油猴扩展"）。remove 仍为桩。
                if (!chrome.tabs.create) chrome.tabs.create = function (props, cb) { var u = (props && props.url) || ""; try { if (u) { self.__syTabCreateOutbox = self.__syTabCreateOutbox || []; self.__syTabCreateOutbox.push({ url: String(u), active: !props || props.active !== false }); } } catch (e) {} var t = { id: 1, index: 0, windowId: 1, active: true, url: u }; if (typeof cb === "function") { try { cb(t); } catch (e) {} } return Promise.resolve(t); };
                // ★ update 包装（v22，原生存在也要包）：VM MV3 confirmInstall 走
                //     tabs.update(tabId,{url:confirmUrl}) 替换当前页签打开安装确认页
                //     —— 原生 update 是无宿主页签模型的静默 no-op（"No such tab"），
                //     confirm 页 URL 被吞 → .user.js 安装链 9s 回落报"未找到油猴扩展"。
                //     带 url 的 update 一律写 __syTabCreateOutbox（宿主排空 openUrl），
                //     再委托原生（失败/无效果也无害）。
                if (chrome.tabs && !chrome.tabs.__syUpdatePatched) {
                    var origTabsUpdate = typeof chrome.tabs.update === "function" ? chrome.tabs.update.bind(chrome.tabs) : null;
                    chrome.tabs.update = function (id, props, cb) {
                        var u = (props && props.url) || "";
                        try { if (u) { self.__syTabCreateOutbox = self.__syTabCreateOutbox || []; self.__syTabCreateOutbox.push({ url: String(u), active: !props || props.active !== false }); } } catch (e) {}
                        // ★ 必须恒返回 Promise：Electron 原生 update 可能返回 undefined，
                        //     VM 的 .catch(noop) 链会炸（实测 "reading 'catch' of undefined"）
                        var out = null;
                        if (origTabsUpdate) { try { out = origTabsUpdate(id, props, cb); } catch (e) { out = null; } }
                        if (!out || typeof out.then !== "function") {
                            var t = { id: typeof id === "number" ? id : 1, url: u };
                            if (typeof cb === "function") { try { cb(t); } catch (e2) {} }
                            out = Promise.resolve(t);
                        }
                        return out;
                    };
                    chrome.tabs.__syUpdatePatched = true;
                }
                if (!chrome.tabs.remove) chrome.tabs.remove = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
                // ★ windows 补桩（v22）：原生 windows 对象存在但缺 getCurrent 等
                //     （"有对象无方法"，同 0f 的镜像问题）—— VM 的 qt 用
                //     windows.getCurrent 解析窗口上下文，缺方法直接 TypeError。
                if (chrome.windows && !chrome.windows.__syWinPatched) {
                    var syWinStub = function () { return { id: 1, index: 0, focused: true, type: "normal", state: "normal", incognito: false, alwaysOnTop: false, width: 1200, height: 800, left: 0, top: 0, tabs: [{ id: 1, url: "" }] }; };
                    var syWinMethod = function (w) { return function (q, cb) { var win = w(); if (typeof q === "function") { try { q(win); } catch (e) {} return; } if (typeof cb === "function") { try { cb(win); } catch (e) {} } return Promise.resolve(win); }; };
                    if (typeof chrome.windows.getCurrent !== "function") chrome.windows.getCurrent = syWinMethod(syWinStub);
                    if (typeof chrome.windows.getLastFocused !== "function") chrome.windows.getLastFocused = syWinMethod(syWinStub);
                    if (typeof chrome.windows.get !== "function") chrome.windows.get = syWinMethod(syWinStub);
                    if (typeof chrome.windows.getAll !== "function") chrome.windows.getAll = function (q, cb) { var win = syWinStub(); if (typeof q === "function") { try { q([win]); } catch (e) {} return; } if (typeof cb === "function") { try { cb([win]); } catch (e) {} } return Promise.resolve([win]); };
                    if (typeof chrome.windows.update !== "function") chrome.windows.update = function (id, props, cb) { var win = syWinStub(); if (typeof cb === "function") { try { cb(win); } catch (e) {} } return Promise.resolve(win); };
                    chrome.windows.__syWinPatched = true;
                }
                // ★ get 包装（v22，原生存在也要包）：VM maybeInstallUserJs 的
                //     getTab(tabId) 在合成 tabId（出箱/派发用 id=1）上原生恒 reject
                //     "No such tab" → await 抛 → confirmInstall 永不执行。失败兜底
                //     返回最小假 tab，语义对齐"页签存在但无导航信息"。
                if (chrome.tabs && !chrome.tabs.__syGetPatched) {
                    var origTabsGet = typeof chrome.tabs.get === "function" ? chrome.tabs.get.bind(chrome.tabs) : null;
                    chrome.tabs.get = function (id, cb) {
                        var fake = { id: typeof id === "number" ? id : 1, index: 0, windowId: 1, active: false, pinned: false, incognito: false, url: "", title: "" };
                        var p = origTabsGet
                            ? Promise.resolve().then(function () { return origTabsGet(id); }).catch(function () { return fake; })
                            : Promise.resolve(fake);
                        if (typeof cb === "function") {
                            p.then(function (t) { try { cb(t); } catch (e) {} }, function () { try { cb(fake); } catch (e) {} });
                            return;
                        }
                        return p;
                    };
                    chrome.tabs.__syGetPatched = true;
                }
                if (!chrome.tabs.reload) chrome.tabs.reload = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
                if (chrome.tabs.TAB_ID_NONE === undefined) chrome.tabs.TAB_ID_NONE = -1;
                // 5b-2) declarativeNetRequest 虚拟存储：AdGuard 引擎启动会把十几万条
                //     规则经 updateDynamicRules/updateSessionRules 写入 Electron 原生
                //     DNR —— 实测大规则集写入挂起，Engine.start 永不返回，其后的消息
                //     handler 注册全部不执行（设置页/弹窗数据全 undefined）。宿主的
                //     dnrEngine 已独立执行真实拦截，这里把写入/读出改为**内存虚拟
                //     存储**（写入即时成功且可回读——tswebextension 应用规则后会
                //     校验回读，空回读会死循环重试），init 顺利越过；规则不触达
                //     原生 DNR（真实拦截由宿主 dnrEngine 负责）。
                if (chrome.declarativeNetRequest) {
                    self.__syDnrStore = { dynamic: [], session: [] };
                    const syDnrApply = function (store, p) {
                        p = p || {};
                        var remove = p.removeRuleIds || [];
                        var add = p.addRules || [];
                        for (var i = 0; i < remove.length; i++) {
                            store = store.filter(function (r) { return r.id !== remove[i]; });
                        }
                        for (var j = 0; j < add.length; j++) {
                            var found = false;
                            for (var k = 0; k < store.length; k++) {
                                if (store[k].id === add[j].id) { store[k] = add[j]; found = true; break; }
                            }
                            if (!found) store.push(add[j]);
                        }
                        return store;
                    };
                    const syDnrOk = function (cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
                    chrome.declarativeNetRequest.updateDynamicRules = function (p, cb) {
                        self.__syDnrStore.dynamic = syDnrApply(self.__syDnrStore.dynamic, p);
                        return syDnrOk(cb);
                    };
                    chrome.declarativeNetRequest.updateSessionRules = function (p, cb) {
                        self.__syDnrStore.session = syDnrApply(self.__syDnrStore.session, p);
                        return syDnrOk(cb);
                    };
                    chrome.declarativeNetRequest.getDynamicRules = function (p, cb) {
                        var cb2 = typeof p === "function" ? p : cb;
                        if (typeof cb2 === "function") { try { cb2(self.__syDnrStore.dynamic); } catch (e) {} }
                        // ★ Promise 路径必须返回数组（不能 {}）：AdGuard 引擎启动链
                        //   await getDynamicRules() 后直接 .map —— 拿到 {} 抛
                        //   "existingRules.map is not a function" → TsWebExtension
                        //   innerStart 失败 → 整个 app 初始化中断（TabsApi 等全没跑）
                        //   → popup 永远卡 loader（2026-10-31 实测定案）
                        return Promise.resolve(self.__syDnrStore.dynamic);
                    };
                    chrome.declarativeNetRequest.getSessionRules = function (p, cb) {
                        var cb2 = typeof p === "function" ? p : cb;
                        if (typeof cb2 === "function") { try { cb2(self.__syDnrStore.session); } catch (e) {} }
                        return Promise.resolve(self.__syDnrStore.session);
                    };
                }
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
                        // ★ 恒返回 Promise：VM 的 ft = tabs.sendMessage(...).catch(ht) 直接
                        //   链式调用，undefined 返回值会让 .catch 炸（实测 .user.js 安装链
                        //   在 sendTabCmd("Stop") 处 TypeError 整链死）。
                        return new Promise(function (resolve) {
                            if (callback) {
                                self.__syTabsPending = self.__syTabsPending || {};
                                self.__syTabsPending[rid] = function (respJson) {
                                    delete self.__syTabsPending[rid];
                                    var resp;
                                    try { resp = respJson == null ? undefined : JSON.parse(respJson); } catch (e3) { resp = undefined; }
                                    try { callback(resp); } catch (e3) {}
                                    resolve(resp);
                                };
                                setTimeout(function () {
                                    if (self.__syTabsPending && self.__syTabsPending[rid]) {
                                        delete self.__syTabsPending[rid];
                                        try { callback(undefined); } catch (e3) {}
                                        resolve(undefined);
                                    }
                                }, 20000);
                            } else {
                                resolve(undefined);
                            }
                        });
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
        // 6) chrome.userScripts 适配（Tampermonkey 等 MV3 用户脚本扩展）：
        //    Electron 原生缺 userScripts API（probe 实测），TM 5.x 探测不到即
        //    降级为"无法运行脚本"。按 Chrome 契约补一层：注册表存内存 +
        //    chrome.storage.local 持久化（SW 重启后 getScripts 仍可答），并用
        //    自增版本号标记变更 —— 宿主（userscriptInjector.ts）比对版本号，
        //    变了就全量对账注册表，把脚本代码注入页面自建世界执行；GM API 由
        //    扩展自身 bootstrap 经 chrome.runtime.sendMessage（v15 路由）与 SW
        //    通信。注意 TM 幂等：GA() 每次启动 getScripts 后可能不再重复
        //    register —— 全量对账 + 持久化 + 启动水合是唯一可靠的宿主同步通道。
        try {
            if (!chrome.userScripts) {
                var US_KEY = "__syUserScriptsReg";
                var US_VER_KEY = "__syUserScriptsRegVersion";
                var usLoad = function () {
                    return new Promise(function (resolve) {
                        try {
                            chrome.storage.local.get([US_KEY, US_VER_KEY], function (v) {
                                resolve({ reg: (v && v[US_KEY]) || {}, ver: (v && v[US_VER_KEY]) || 0 });
                            });
                        } catch (e2) { resolve({ reg: {}, ver: 0 }); }
                    });
                };
                var usSave = function (reg, ver) {
                    try {
                        var item = {};
                        item[US_KEY] = reg;
                        item[US_VER_KEY] = ver;
                        chrome.storage.local.set(item);
                    } catch (e2) {}
                };
                var usClone = function (x) { try { return JSON.parse(JSON.stringify(x)); } catch (e2) { return x; } };
                var usCommit = function (reg, ver) {
                    self.__syUserScriptsReg = reg;
                    self.__syUserScriptsVersion = ver;
                    usSave(reg, ver);
                };
                // SW 启动即异步水合内存注册表与版本号（宿主 drain 直接读内存，
                // 不依赖扩展先调用过一次 API；TM 幂等跳过 register 时也拿得到）
                self.__syUserScriptsReg = self.__syUserScriptsReg || {};
                self.__syUserScriptsVersion = self.__syUserScriptsVersion || 0;
                usLoad().then(function (loaded) {
                    self.__syUserScriptsReg = loaded.reg;
                    self.__syUserScriptsVersion = loaded.ver;
                });
                chrome.userScripts = {
                    ExecutionWorld: { MAIN: "MAIN", USER_SCRIPT: "USER_SCRIPT" },
                    register: function (scripts, cb) {
                        return usLoad().then(function (loaded) {
                            var reg = loaded.reg;
                            scripts = Array.isArray(scripts) ? scripts : [scripts];
                            for (var i = 0; i < scripts.length; i++) {
                                var s = scripts[i];
                                if (!s || !s.id) continue;
                                reg[s.id] = usClone(s);
                            }
                            usCommit(reg, loaded.ver + 1);
                            if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        });
                    },
                    getScripts: function (filter, cb) {
                        var cb2 = typeof filter === "function" ? filter : cb;
                        return usLoad().then(function (loaded) {
                            var reg = loaded.reg;
                            var ids = (filter && typeof filter === "object" && filter.ids) || null;
                            var list = [];
                            for (var k in reg) { if (!ids || ids.indexOf(k) >= 0) list.push(reg[k]); }
                            if (typeof cb2 === "function") { try { cb2(list); } catch (e3) {} }
                            return list;
                        });
                    },
                    unregister: function (filter, cb) {
                        return usLoad().then(function (loaded) {
                            var reg = loaded.reg;
                            var ids = (filter && filter.ids) || null;
                            for (var k in reg) { if (!ids || ids.indexOf(k) >= 0) delete reg[k]; }
                            usCommit(reg, loaded.ver + 1);
                            if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        });
                    },
                    update: function (ids, props, cb) {
                        return usLoad().then(function (loaded) {
                            var reg = loaded.reg;
                            ids = Array.isArray(ids) ? ids : [ids];
                            props = Array.isArray(props) ? props : ids.map(function () { return props; });
                            for (var i = 0; i < ids.length; i++) {
                                if (reg[ids[i]] && props[i]) {
                                    var merged = usClone(reg[ids[i]]);
                                    for (var k2 in props[i]) merged[k2] = props[i][k2];
                                    reg[ids[i]] = merged;
                                }
                            }
                            usCommit(reg, loaded.ver + 1);
                            if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        });
                    },
                    reset: function (cb) {
                        return usLoad().then(function (loaded) {
                            usCommit({}, loaded.ver + 1);
                            if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        });
                    },
                    configureWorld: function (props, cb) {
                        // messaging/csp：自建世界恒有消息桥，无需配置
                        if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        return Promise.resolve();
                    },
                    // execute（v23 增）：MV3 用户脚本代码的 SW→页面 下发通道。
                    // Violentmonkey 注入链的关键路径：页面引导在隔离世界拿不到页面
                    // realm（GetInjected 回包 page:false → 引导发 InjectionFeedback
                    // 带 forceContent:true）→ SW 侧 triageRealms 把脚本判为 content
                    // realm → 真实脚本代码经 injectContentRealm → userScripts.execute
                    // 下发。缺此方法时代码静默丢失（setTimeout fire-and-forget 吞错），
                    // 页面只收到 code:"" 的空壳 → Run{ids:[]} 永远无脚本执行。
                    // SW 无法直接 eval 页面 —— 代码落 __syUsExecOutbox，宿主
                    // cs-runtime 的 SW 回包泵（600ms 轮询）取走后在扩展自建世界执行
                    // （= Chrome USER_SCRIPT 世界语义：与引导同世界，共享 VM bridge
                    // 全局）。回包 [{result:null}]：VM 只用结果通知 UNWRAP/报错，
                    // 代码执行本身 fire-and-forget。
                    execute: function (details) {
                        try {
                            var jsCode = "";
                            if (details && details.js) {
                                for (var i = 0; i < details.js.length; i++) {
                                    jsCode += (details.js[i] && details.js[i].code) || "";
                                }
                            }
                            // 可注入性探针短路（VM isInjectable 发 code:'true' 并要求
                            // [0].result===true）：宿主对每个 http(s) 页无条件建 VM
                            // 内容世界，探针恒可执行 —— 直接断言成功。恒回 null 会让
                            // initPopup 判 noninjectable → 面板 "cannot run userscripts"
                            // + 空列表（首启实测必然复现，非时序问题）。
                            if (jsCode === "true") {
                                return Promise.resolve([{ result: true }]);
                            }
                            if (jsCode) {
                                self.__syUsExecOutbox = self.__syUsExecOutbox || [];
                                self.__syUsExecOutbox.push({
                                    code: jsCode,
                                    injectImmediately: !!(details && details.injectImmediately),
                                    tabId: details && details.target ? details.target.tabId : undefined,
                                    frameIds: details && details.target && details.target.frameIds || null,
                                });
                            }
                        } catch (e2) {}
                        return Promise.resolve([{ result: null }]);
                    },
                };
            }
        } catch (e) {}
        // 7) notifications / downloads 最小动作桩（v15 只补了事件壳，TM 的
        //    GM_notification / GM_download 走这两个 API，缺 create/download 直接抛）
        try {
            if (chrome.notifications && !chrome.notifications.create) {
                chrome.notifications.create = function (id, opts, cb) {
                    if (typeof id === "object") { opts = id; id = "n" + Date.now(); }
                    console.log("[sy-shim] notifications.create:", (opts && opts.title) || id);
                    if (typeof cb === "function") { try { cb(id); } catch (e3) {} }
                    return id;
                };
                chrome.notifications.clear = function (id, cb) { if (typeof cb === "function") { try { cb(true); } catch (e3) {} } return Promise.resolve(true); };
                chrome.notifications.update = function (id, opts, cb) { if (typeof cb === "function") { try { cb(true); } catch (e3) {} } return Promise.resolve(true); };
            }
            if (chrome.downloads && !chrome.downloads.download) {
                chrome.downloads.download = function (opts, cb) {
                    console.warn("[sy-shim] chrome.downloads.download 未实现（改用页内下载）:", opts && opts.url);
                    if (typeof cb === "function") { try { cb(undefined); } catch (e3) {} }
                    return Promise.resolve(undefined);
                };
            }
        } catch (e) {}
        // 9) webRequest 真实事件面 + 阻塞桥（2026-10-31"阻塞桥"定案）：扩展的
        //    webRequest 监听器由宿主代理——垫片在 addListener 时**连同 filter
        //    （urls/types）一起登记**并暴露快照；宿主（BrowserTab registerWebRequest）
        //    对每个请求先按 filter 预筛，命中才经 evalInSw 合成派发，收集扩展
        //    返回的 {cancel/redirectUrl} 并执行。TM 的 .user.js 安装拦截（阻塞 +
        //    ask.html?aid 重定向）由此原生走通（真 ask.html 确认页）。派发量被
        //    filter 预筛压到趋近于零，不拖累页面加载。
        try {
            if (chrome.webRequest && !chrome.webRequest.__syReal) {
                var wrFns = self.__syWebRequestFns = self.__syWebRequestFns || {};
                var wrFilters = self.__syWebRequestFilters = self.__syWebRequestFilters || {};
                var wrEv = function (name) {
                    var entries = wrFns[name] = wrFns[name] || [];
                    var filters = wrFilters[name] = wrFilters[name] || [];
                    return {
                        addListener: function (fn, filter) {
                            if (typeof fn !== "function") return;
                            entries.push(fn);
                            filters.push(filter && typeof filter === "object"
                                ? { urls: Array.isArray(filter.urls) ? filter.urls.map(String) : null, types: Array.isArray(filter.types) ? filter.types.map(String) : null }
                                : null);
                        },
                        removeListener: function (fn) {
                            var i = entries.indexOf(fn);
                            if (i >= 0) { entries.splice(i, 1); filters.splice(i, 1); }
                        },
                        hasListener: function (fn) { return entries.indexOf(fn) >= 0; },
                    };
                };
                chrome.webRequest = {
                    __syReal: true,
                    onBeforeRequest: wrEv("onBeforeRequest"),
                    onBeforeSendHeaders: wrEv("onBeforeSendHeaders"),
                    onSendHeaders: wrEv("onSendHeaders"),
                    onHeadersReceived: wrEv("onHeadersReceived"),
                    onAuthRequired: wrEv("onAuthRequired"),
                    onBeforeRedirect: wrEv("onBeforeRedirect"),
                    onResponseStarted: wrEv("onResponseStarted"),
                    onCompleted: wrEv("onCompleted"),
                    onErrorOccurred: wrEv("onErrorOccurred"),
                    MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
                    OnBeforeSendHeadersOptions: { EXTRA_HEADERS: ["extraHeaders"] },
                    OnHeadersReceivedOptions: { EXTRA_HEADERS: ["extraHeaders"] },
                    OnAuthRequiredOptions: { EXTRA_HEADERS: ["extraHeaders"] },
                    handlerBehaviorChanged: function (cb) { if (typeof cb === "function") { try { cb(); } catch (eWr) {} } return Promise.resolve(); },
                };
            }
        } catch (e) {}
        // 10) downloads 真实事件面：TM MV3 的 .user.js 安装入口是
        //     downloads.onCreated（真 Chrome 把 .user.js 当下载，TM 观察后自己
        //     fetch URL、登记待装、tabs.create 开 ask.html）。宿主拦 .user.js
        //     导航后经 evalInSw 调 __syEmitDownload 合成下载事件 → TM 原生安装
        //     流（含 ask.html?aid 确认页）完整走通。search 按宿主合成条目作答。
        try {
            if (chrome.downloads && !chrome.downloads.__syReal) {
                var dlFns = self.__syDownloadFns = self.__syDownloadFns || {};
                var dlEv = function (name) {
                    var fns = dlFns[name] = dlFns[name] || [];
                    return {
                        addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                        removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                        hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
                    };
                };
                var dlItems = self.__syDownloadItems = self.__syDownloadItems || {};
                chrome.downloads.__syReal = true;
                chrome.downloads.onCreated = dlEv("onCreated");
                chrome.downloads.onChanged = dlEv("onChanged");
                chrome.downloads.onErased = dlEv("onErased");
                chrome.downloads.search = function (q, cb) {
                    var items = [];
                    try {
                        for (var k in dlItems) {
                            var it = dlItems[k];
                            if (!q || (!q.id && !q.url) || (q.id && String(it.id) === String(q.id)) || (q.url && String(it.url).indexOf(String(q.url)) >= 0)) items.push(it);
                        }
                    } catch (eDl1) {}
                    if (typeof cb === "function") { try { cb(items); } catch (eDl2) {} }
                    return Promise.resolve(items);
                };
                chrome.downloads.cancel = function (id, cb) { if (typeof cb === "function") { try { cb(true); } catch (eDl3) {} } return Promise.resolve(true); };
                chrome.downloads.erase = function (q, cb) { if (typeof cb === "function") { try { cb([]); } catch (eDl4) {} } return Promise.resolve([]); };
                chrome.downloads.pause = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (eDl5) {} } return Promise.resolve(); };
                chrome.downloads.resume = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (eDl6) {} } return Promise.resolve(); };
                // 宿主入口：合成一条下载（触发 onCreated 监听器）
                self.__syEmitDownload = function (url) {
                    var did = "sy-dl-" + Date.now();
                    var item = { id: did, url: String(url), filename: decodeURIComponent((String(url).split("?")[0].split("/").pop() || "file")), state: "in_progress", bytesReceived: 0, totalBytes: 0, mime: "text/plain" };
                    dlItems[did] = item;
                    var fns2 = dlFns.onCreated || [];
                    for (var j = 0; j < fns2.length; j++) { try { fns2[j](item); } catch (eDl7) {} }
                    // ★ 立即补 onChanged → complete：TM 的安装处理在下载完成后才开始
                    //   （真 Chrome 下载瞬间完成），合成条目停在 in_progress 会让其
                    //   handler 永远等待（实测 ask.html 永不开）。合成下载没有真实
                    //   传输过程，直接落到 complete。
                    item.state = "complete";
                    item.bytesReceived = 1;
                    item.totalBytes = 1;
                    var fns3 = dlFns.onChanged || [];
                    var delta = { id: did, state: { previous: "in_progress", current: "complete" } };
                    for (var k = 0; k < fns3.length; k++) { try { fns3[k](delta); } catch (eDl8) {} }
                    return did;
                };
            }
        } catch (e) {}
        // 11) webNavigation 真实事件面：TM 的安装检测（.user.js 导航观察）与
        //     各类 URL 感知逻辑依赖导航事件流；哑桩时代注册被静默吞掉。宿主
        //     （BrowserTab did-navigate）按 onCommitted 合成派发，监听器数组
        //     暴露到 self.__syWebNavFns 供宿主预筛。
        try {
            if (chrome.webNavigation && !chrome.webNavigation.__syReal) {
                var wnFns = self.__syWebNavFns = self.__syWebNavFns || {};
                var wnEv = function (name) {
                    var fns = wnFns[name] = wnFns[name] || [];
                    return {
                        addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                        removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                        hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
                    };
                };
                chrome.webNavigation = {
                    __syReal: true,
                    onBeforeNavigate: wnEv("onBeforeNavigate"),
                    onCommitted: wnEv("onCommitted"),
                    onDOMContentLoaded: wnEv("onDOMContentLoaded"),
                    onCompleted: wnEv("onCompleted"),
                    onErrorOccurred: wnEv("onErrorOccurred"),
                    onCreatedNavigationTarget: wnEv("onCreatedNavigationTarget"),
                    onHistoryStateUpdated: wnEv("onHistoryStateUpdated"),
                    onReferenceFragmentUpdated: wnEv("onReferenceFragmentUpdated"),
                    onTabReplaced: wnEv("onTabReplaced"),
                    getAllFrames: function (opts, cb) { var v = [{ frameId: 0, url: String(location.href), parentFrameId: -1 }]; if (typeof cb === "function") { try { cb(v); } catch (eWn1) {} } return Promise.resolve(v); },
                    getFrame: function (opts, cb) { var v = { frameId: 0, url: String(location.href), parentFrameId: -1 }; if (typeof cb === "function") { try { cb(v); } catch (eWn2) {} } return Promise.resolve(v); },
                };
            }
        } catch (e) {}
    } catch (e) {}
})();
/* sy-bg-shim-end */
`;

        let shimHash = 0x811c9dc5;
        for (let i = 0; i < shimBody.length; i++) {
            shimHash ^= shimBody.charCodeAt(i);
            shimHash = Math.imul(shimHash, 0x01000193);
        }
        const SHIM_MARK = "/* sy-bg-shim:" + SHIM_VER + ":" + (shimHash >>> 0).toString(36) + " */";
        for (const ext of this.extensions) {
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(ext.path, "manifest.json"), "utf8"));
                const swPath = manifest.background?.service_worker;
                if (!swPath) continue;
                const abs = path.join(ext.path, swPath);
                const src = fs.readFileSync(abs, "utf8");
                // 只在真的用到缺失 API 时才垫（省得污染没问题的扩展）。
                // 注意：商店扩展的 background 多为压缩代码，chrome 常被别名化
                // （实测 TM：`C.contextMenus`，全文无 "chrome." 字样）—— 检测必须
                // 用裸关键字，不能带 chrome. 前缀。
                const needsShim = /contextMenus|userScripts|notifications|webNavigation|alarms|omnibox|declarativeNetRequest|cookies|browserAction|browser_action|chrome\.(commands|action|downloads)/.test(src);
                if (!needsShim) continue;
                if (src.startsWith(SHIM_MARK)) continue;
                const shim = SHIM_MARK + shimBody;
                // 换版剥离：文件里带旧版垫片且含尾标记 → 截掉垫片段，只保留原源码再前置新垫片
                //（lastIndexOf：多层堆叠时以最新一代的尾标记为准）
                let original = src;
                if (/^\/\* sy-bg-shim:v\d+[^*]*\*\//.test(original)) {
                    const endMark = "/* sy-bg-shim-end */";
                    const ei = original.lastIndexOf(endMark);
                    if (ei >= 0) original = original.slice(ei + endMark.length).replace(/^\s*\n/, "");
                    // 无尾标记的旧版（v17/v16）走守卫幂等堆叠：shim + (旧shim... + 原源码)
                }
                fs.writeFileSync(abs, shim + original, "utf8");
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
            if (ext.popupPath !== undefined && ext.iconPath !== undefined && ext.newtabPath !== undefined) continue;
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
                if (ext.newtabPath === undefined) {
                    ext.newtabPath = manifest.chrome_url_overrides?.newtab
                        || manifest.chrome_url_overrides?.homepage
                        || undefined;
                }
                if (ext.optionsPath === undefined) {
                    ext.optionsPath = manifest.options_ui?.page
                        || manifest.options_page
                        || undefined;
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

    /** 宿主数据是否就绪（load() 已完成）。启动恢复页签可能早于本方法完成，
     *  WebviewController 据此判断 chrome-extension:// 导航该放行还是保守改道。 */
    isLoaded(): boolean {
        return this.loaded;
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
                // 新标签页扩展：chrome_url_overrides.newtab（可作为新页签默认页）
                newtabPath: manifest.chrome_url_overrides?.newtab
                    || manifest.chrome_url_overrides?.homepage
                    || undefined,
                optionsPath: manifest.options_ui?.page
                    || manifest.options_page
                    || undefined,
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
            // 直连微软 CDN 常被网络环境重置（Node http/https 不走系统代理），
            // 失败时经内核 forwardProxy 兜底下载
            const kernelRpc = (this.plugin as any)?.kernel?.rpc?.call;
            const buf = await downloadEdgeCrxWithFallback(id, kernelRpc);
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
        if (!msg) return "";
        var arr = args == null ? [] : (Array.isArray(args) ? args : [args]);
        // named placeholders（$name$ → placeholders[name].content，content 可为
        // "$1" 引用或常量）—— 与 cs-runtime 页面世界垫片同实现
        var ph = entry && entry.placeholders;
        if (ph) {
            msg = msg.replace(/\\$([A-Za-z_][A-Za-z0-9_]*)\\$/g, function(m, name) {
                var p = ph[name];
                if (!p) return m;
                var c = String(p.content == null ? "" : p.content);
                return c.replace(/\\$(\\d+)/g, function(m2, i2) {
                    var v = arr[Number(i2) - 1];
                    return v != null ? String(v) : m2;
                });
            });
        }
        if (msg && args != null) {
            var arr2 = Array.isArray(args) ? args : [args];
            msg = msg.replace(/\\$(\\d+)/g, function(m, i) { return arr2[Number(i) - 1] != null ? arr2[Number(i) - 1] : m; });
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
                        // 内容世界 tab 身份（真 Chrome sender.tab 语义，见 ICsExtInfo）
                        senderTabId: 1,
                        optionsPath: e.optionsPath,
                        popupPath: e.popupPath,
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
            userData: async (kind: string, args: any) => {
                const plugin = this.plugin;
                // topSites：从历史库按 origin 聚合访问次数取 Top N
                if (kind === "topSites") {
                    const items: any[] = plugin?.historyStore?.list?.() || [];
                    const byOrigin = new Map<string, { url: string; title: string; count: number }>();
                    for (const it of items) {
                        try {
                            const u = new URL(it.url);
                            // 扩展页/内部页不进 topSites（历史库可能有旧数据）
                            if (!/^https?:$/.test(u.protocol)) continue;
                            const cur = byOrigin.get(u.origin) || { url: it.url, title: it.title || u.hostname, count: 0 };
                            cur.count++;
                            byOrigin.set(u.origin, cur);
                        } catch {}
                    }
                    return [...byOrigin.values()]
                        .sort((a, b) => b.count - a.count)
                        .slice(0, 20)
                        .map((x) => ({ url: x.url, title: x.title }));
                }
                if (kind === "bookmarkTree") {
                    const bms: any[] = plugin?.bookmarksStore?.list?.() || [];
                    return [{
                        id: "0",
                        title: "",
                        children: [{
                            id: "1",
                            title: "书签栏",
                            children: bms.map((b, i) => ({ id: "1." + i, title: b.title || b.url, url: b.url })),
                        }],
                    }];
                }
                if (kind === "bookmarkRecent") {
                    const bms: any[] = plugin?.bookmarksStore?.list?.() || [];
                    return bms.slice(0, Number(args?.n) || 10).map((b, i) => ({ id: "r" + i, title: b.title || b.url, url: b.url }));
                }
                if (kind === "bookmarkSearch") {
                    const bms: any[] = plugin?.bookmarksStore?.search?.(String(args?.query || "")) || [];
                    return bms.map((b, i) => ({ id: "s" + i, title: b.title || b.url, url: b.url }));
                }
                if (kind === "historySearch") {
                    const q = args?.query || {};
                    const text = String(q.text || "").toLowerCase();
                    const max = Number(q.maxResults) > 0 ? Number(q.maxResults) : 100;
                    let items: any[] = plugin?.historyStore?.list?.() || [];
                    if (text) {
                        items = items.filter((it) => String(it.title || "").toLowerCase().includes(text) || String(it.url || "").toLowerCase().includes(text));
                    }
                    return items.slice(0, max).map((it, i) => ({
                        id: "h" + i,
                        url: it.url,
                        title: it.title || it.url,
                        lastVisitTime: Number(it.visitTime) || 0,
                        visitCount: 1,
                        typedCount: 0,
                    }));
                }
                return null;
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

    // ===== SW 保活（对齐 Chrome 的"事件即唤醒"体感）=====
    //
    // MV3 SW 空闲 ~30s 即休眠：休眠后 popup/消息要先唤醒（startWorkerForScope
    // 或 remove+load，实测数秒级），体感是"弹窗首开慢/消息迟钝"。浏览器页签
    // 存在期间每 20s 用 startWorkerForScope（无副作用，只启动不卸载）对全部
    // 原生扩展 SW 做一轮保活，SW 进程常驻、事件即时响应。代价是常驻内存
    // （每个 SW 进程几十 MB），换取 Chrome 同款的即时性。
    private swKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

    startSwKeepAlive(): void {
        if (this.swKeepAliveTimer) return;
        const tick = () => {
            const ses = remoteSession();
            if (!ses?.serviceWorkers?.startWorkerForScope) return;
            for (const ext of this.extensions.filter((e) => e.enabled && e.native && !!e.electronId)) {
                try {
                    ses.serviceWorkers.startWorkerForScope(`chrome-extension://${ext.electronId}/`).catch(() => {});
                } catch {}
            }
        };
        tick();
        this.swKeepAliveTimer = setInterval(tick, 20000);
    }

    stopSwKeepAlive(): void {
        if (this.swKeepAliveTimer) {
            clearInterval(this.swKeepAliveTimer);
            this.swKeepAliveTimer = null;
        }
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

    /**
     * dom-ready 时调用（ensureCsRuntime 之后）：把 chrome.userScripts 注册的
     * 用户脚本（Tampermonkey 的引导包与用户脚本）注入本页的扩展自建世界。
     * 见 userscriptInjector.ts 的分工说明。
     */
    injectNativeUserScripts(webview: IWebviewTag, url: string): void {
        try {
            if (!this.loaded) return;
            void this.usInjector.injectForPage(webview, url);
        } catch (e) {
            console.warn("[browser-plugin] injectNativeUserScripts failed:", e);
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

            // 快速安装行：常用扩展一键从 Edge 加载项商店下载安装（直连失败自动走内核代理兜底）
            const quickToolbar = document.createElement("div");
            quickToolbar.style.cssText = "display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center;";
            const quickLabel = document.createElement("span");
            quickLabel.style.cssText = "font-size:12px;color:var(--b3-theme-on-surface-light);";
            quickLabel.textContent = i18n.extQuickInstall || "快速安装：";
            quickToolbar.appendChild(quickLabel);
            for (const q of QUICK_INSTALL_EDGE) {
                const qBtn = document.createElement("button");
                qBtn.className = "b3-button";
                qBtn.textContent = q.label;
                qBtn.addEventListener("click", async () => {
                    qBtn.disabled = true;
                    const originalText = qBtn.textContent;
                    qBtn.textContent = i18n.extEdgeDownloading || "下载中...";
                    try {
                        const r = await this.installFromEdgeAddons(q.id);
                        if (r.ok) {
                            showMessage((i18n.extInstalled || "已安装扩展") + ": " + r.ext!.name, 3000, "info");
                            render();
                        } else {
                            showMessage((i18n.extInstallFailed || "安装扩展失败") + ": " + r.error, 6000, "error");
                        }
                    } finally {
                        qBtn.disabled = false;
                        qBtn.textContent = originalText;
                    }
                });
                quickToolbar.appendChild(qBtn);
            }
            // 新标签页类扩展：商店搜索页（详情页点"安装到思源"即可安装，装完在插件设置里启用）
            const newTabBtn = document.createElement("button");
            newTabBtn.className = "b3-button b3-button--cancel";
            newTabBtn.textContent = i18n.extQuickNewTab || "新标签页扩展（商店搜索）";
            newTabBtn.title = i18n.newTabExtDesc || "安装带新标签页的扩展（如 Momentum）后，在插件设置「新标签页扩展」里启用";
            newTabBtn.addEventListener("click", () => {
                const plugin = (window as any).browserPlugin;
                if (plugin?.openUrl) plugin.openUrl("https://microsoftedge.microsoft.com/addons/search/new%20tab");
                else window.open("https://microsoftedge.microsoft.com/addons/search/new%20tab", "_blank");
            });
            quickToolbar.appendChild(newTabBtn);
            container.appendChild(quickToolbar);

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
