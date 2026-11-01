import { Menu, showMessage } from "siyuan";
import type { BrowserSettings, IWebviewTag } from "../types";
import { Toolbar } from "./Toolbar";
import { WebviewController } from "./WebviewController";
import { el } from "../utils/dom";
import { normalizeUrl } from "../utils/url";
import type { HistoryStore } from "../storage/historyStore";
import type { BookmarksStore } from "../storage/bookmarksStore";
import type { SettingsStore } from "../storage/settingsStore";
import { SettingsDialog } from "../settings/SettingsDialog";
import { clipToSiYuan } from "./excerpt";
import { EDGE_UA } from "../extensions/edgeStore";
import { isEdgeAddonsSiteUrl } from "../extensions/edgeStoreHelper";
import { BROWSER_PARTITION } from "../constants";
import { remoteSession } from "../utils/electron";
import { closeExtensionPopupInPage, injectExtensionPageRuntime, POPUP_JS_PRELUDE, readExtLsSeed, persistExtLs } from "./ext-popup";
import { ExtensionPopupOverlay } from "./PopupOverlay";
import { dnrBlocker } from "./dnrEngine";
import { evalInExtensionWorld } from "../extensions/sw-bridge";
import { beginPopupWorld, evalPopupJs, evalInExtensionWorldBridge, feedTabEventForPopup, evalInSwByElectronId } from "../extensions/cs-runtime";
import type { IExtensionMenuItem } from "./contextMenu";

/** 浏览器页签实例依赖 */
export interface BrowserTabDeps {
    i18n: Record<string, string>;
    settings: SettingsStore;
    history: HistoryStore;
    bookmarks: BookmarksStore;
    openUrlInNewTab: (url: string) => void;
    /** 触发下载（由 index.ts 注入，调用内核 RPC） */
    startDownload: (url: string, suggestedName?: string) => Promise<void>;
    /** 通知页签标题更新（思源 tab 头部） */
    onTabTitleChange: (title: string) => void;
    /** 通知页签图标更新 */
    onTabIconChange: (icon: string) => void;
    /** Chrome 扩展内容脚本注入（每次 webview 页面 dom-ready 时调用） */
    injectExtensions?: (webview: IWebviewTag, url: string) => void;
    /** Edge 加载项商店安装（详情页悬浮按钮 / 协议跳转拦截触发） */
    installEdgeExtension?: (id: string, source: string) => Promise<{ ok: boolean; error?: string; ext?: any } | void>;
    /** 解析新页签起始 URL（主页 vs 新标签页扩展页面），由插件主实例提供 */
    resolveStartUrl?: () => string;
}

/**
 * 浏览器页签模型：每个浏览器页签实例对应一个 BrowserTab。
 * 由 SiYuan 自定义页签的 init() 创建，destroy() 销毁。
 */
export class BrowserTab {
    readonly element: HTMLElement;
    private toolbar: Toolbar;
    private webview: IWebviewTag;
    private controller: WebviewController;
    private deps: BrowserTabDeps;
    private settings: BrowserSettings;
    private disposed = false;
    /** webview 重建中标记（防止重复重建） */
    private rebuilding = false;
    /** 扩展整页垫片注入中（maybeInjectExtensionPage）：重建式注入是受控的重活
     *  （几百 KB DOM/CSS 写入 + 巨型 background 重放，主线程秒级繁忙），
     *  健康监测的 800ms executeJavaScript 探测必超时 —— 不挂起会误判 broken
     *  触发 rebuild 循环（实测 TM options 页打开即洗白）。 */
    private extPageInjecting = false;
    /** webview 健康监测定时器 */
    private healthTimer: any = null;
    // Chrome 式扩展 popup：常温独立文档 overlay（文档全新、进程温热，见 PopupOverlay.ts）
    private extPopup: ExtensionPopupOverlay | null = null;
    /** .user.js 待装脚本（确认弹窗 → confirmInstall 的中转） */
    private pendingInstalls = new Map<string, { url: string; code: string; name: string; version: string; author: string; description: string; matches: string[]; electronId: string; extName: string }>();
    private pendingInstallDialogs = new Set<HTMLElement>();
    /** 安装确认弹窗防重入：url（去查询串）→ 上次展示时间。文本页留在地址栏，
     *  重建/恢复/刷新会重新触发导航——3 分钟内同脚本不重复弹 */
    private installDialogShownAt = new Map<string, number>();
    /** webRequest 阻塞桥：electronId → 该扩展注册的监听器 filter 快照
     *  （垫片 addListener 时连同 urls/types 一起暴露，宿主按此预筛派发） */
    private wrBridgeCache = new Map<string, Array<{ ev: string; urls: string[] | null; types: string[] | null }>>();
    private wrBridgeCacheAt = 0;
    /** .user.js 待装导航（TM ask.html 开出即置 askOpened；12s 未开走宿主弹窗） */
    private pendingUserJs: { url: string; askOpened: boolean } | null = null;

    /** 扩展安装确认页识别：TM = ask.html?aid；VM(Violentmonkey) = confirm/index.html。
     *  出箱排空时据此置 pendingUserJs.askOpened，9s 回落才不会误触发。 */
    private markUserJsChainOpened(u: string): void {
        if (!/ask\.html|confirm\/index\.html/i.test(u)) return;
        const pj = this.pendingUserJs;
        if (pj && !pj.askOpened) pj.askOpened = true;
    }
    /** 连续健康检查失败计数（连续 2 次才判定损坏） */
    private healthFailCount = 0;
    /** Electron 默认 UA（懒捕获：构造时 webview 可能尚未 attach） */
    private defaultUserAgent = "";
    /** 当前是否处于商店伪装 UA 态（离开商店时恢复默认） */
    private edgeUaActive = false;
    /** 已经实际应用到 webContents 的 UA（避免重复设置；webview.useragent 属性不可信） */
    private appliedUserAgent = "";

    constructor(deps: BrowserTabDeps, initialUrl?: string) {
        this.deps = deps;
        this.settings = deps.settings.get();
        this.element = this.buildDom();
        this.webview = this.element.querySelector("webview") as unknown as IWebviewTag;
        this.toolbar = new Toolbar(deps.i18n, {
            onAction: (action, payload) => this.onToolbarAction(action, payload),
            onUrlSubmit: (url) => this.controller.loadURL(url),
            onFindInPage: (text) => this.controller.findInPage(text),
            onExtensionIcon: (extId, anchor) => void this.openExtensionPopup(extId, anchor),
        }, this.settings);
        this.controller = new WebviewController(this.webview, {
            settings: this.settings,
            history: deps.history,
            bookmarks: deps.bookmarks,
            i18n: deps.i18n,
            callbacks: {
                onUrlChange: (url) => {
                    this.toolbar.setUrl(url);
                    this.updateBookmarkButton(url);
                    this.syncUserAgent(url);
                    // 页面跳转后旧面板挂在已废弃的 DOM 上，直接关掉
                    void closeExtensionPopupInPage(this.webview);
                    // TM 安装中转页出现 = TM 已接管 .user.js 安装（原生链条）——
                    // 12s 宿主弹窗回落不再触发
                    if (url && url.includes("script_installation.php") && this.pendingUserJs) {
                        this.pendingUserJs.askOpened = true;
                    }
                    // webNavigation.onCommitted 合成派发（TM 安装检测等导航观察；
                    // chrome-extension/data 页不派发）
                    if (url && /^https?:\/\//i.test(url)) void this.emitWebNavCommitted(url);
                },
                onTitleChange: (title) => {
                    deps.onTabTitleChange(title);
                },
                onLoadingChange: (loading) => {
                    this.toolbar.setLoading(loading);
                    if (!loading) {
                        this.toolbar.setNavState(this.controller.canGoBack(), this.controller.canGoForward());
                        const url = this.controller.getCurrentUrl();
                        if (url) this.updateBookmarkButton(url);
                    }
                },
                onFaviconChange: (favicon) => {
                    // 思源页签图标更新可通过 onTabIconChange 通知
                    deps.onTabIconChange(favicon);
                },
                onOpenNewTab: (url) => deps.openUrlInNewTab(url),
                onSaveAs: (url, name) => {
                    deps.startDownload(url, name);
                },
                onToggleBookmark: () => this.toggleBookmark(),
                onInspect: () => {
                    try {
                        this.webview.openDevTools?.();
                    } catch {}
                },
                onFindResult: (active, total) => {
                    this.toolbar.setFindResult(active, total);
                },
                onExcerpt: (mode: "article" | "part") => {
                    const s = this.settings;
                    clipToSiYuan(this.webview, {
                        mode: mode || "article",
                        notebookId: s.excerptNotebook || "",
                        parentPath: s.excerptParentPath || "/",
                        tags: s.excerptTags || "",
                        assets: s.excerptAssets !== false,
                        exp: {
                            bold: !!s.excerptExpBold,
                            italic: !!s.excerptExpItalic,
                            underline: !!s.excerptExpUnderline,
                            removeImgLink: !!s.excerptExpRemoveImgLink,
                            span: !!s.excerptExpSpan,
                            svgToImg: !!s.excerptExpSvgToImg,
                        },
                    }, this.deps.i18n);
                },
                onEdgeInstall: (id: string, source: string) =>
                    this.deps.installEdgeExtension?.(id, source) ?? Promise.resolve(),
                onProcessGone: (reason: string) => {
                    if (this.disposed || this.rebuilding) return;
                    console.warn("[browser-plugin] webview crashed (" + reason + "), rebuilding webview");
                    void this.rebuildWebview();
                },
            },
        });

        // 把工具栏插到 webview 之前
        this.element.insertBefore(this.toolbar.element, this.webview.parentElement);

        // 扩展 contextMenus 项预热（SiYuan Clip 等）：SW 查询慢且可能唤醒，
        // 后台预热进缓存，右键弹出时同步取用；5 分钟过期后台再刷
        this.controller.setExtensionMenuSource(
            () => this.getExtMenuItems(),
            (item) => {
                // 扩展 contextMenus 项 → 直调扩展在自建世界（cs-runtime.ts）里的
                // 全局分发函数（SiYuan Clip：eventDispatcher）。自建世界的
                // chrome.runtime.sendMessage 已由宿主桥接到 SW 垫片 v4 路由，
                // 无需再装消息桥（installMessageRouteShim 仅剩 Electron 原生
                // 空壳世界可落点，已废弃）。
                void (async () => {
                    const isSend = item.id === "send";
                    const msg = isSend
                        ? { func: "siyuanGetReadability", tabId: 0 }
                        : { func: "copy", tabId: 0, srcUrl: this.controller.lastCtxSrcUrl ?? undefined };
                    const expr = `(() => {
                            try {
                                if (typeof eventDispatcher !== "function") {
                                    return { err: "该扩展未暴露全局分发函数（仅 SiYuan Clip 已适配）" };
                                }
                                eventDispatcher(${JSON.stringify(msg)}, null, function () {});
                                return { dispatched: true };
                            } catch (e) { return { err: String(e && e.stack || e).slice(0, 300) }; }
                        })()`;
                    // flat 通道优先（进程内 Target 域，无调试端口也可用），HTTP /json/list 兜底
                    let r = await evalInExtensionWorldBridge(this.webview, item.electronId, expr);
                    if (!r.ok && r.error && !r.error.includes("该页面没有此扩展的运行时世界")) {
                        r = await evalInExtensionWorld(this.webview, item.electronId, expr);
                    }
                    if (!r.ok || (r.value && r.value.err)) {
                        showMessage(`「${item.title}」触发失败: ${r.error || (r.value && r.value.err)}`, 5000, "error");
                    }
                })();
            },
        );

        // 监听设置变化
        deps.settings.onChange(() => {
            this.settings = deps.settings.get();
            this.toolbar.updateSettings(this.settings);
            this.controller.updateSettings(this.settings);
        });

        // 监听书签变化（更新收藏按钮）
        deps.bookmarks.onChange(() => {
            this.updateBookmarkButton(this.controller.getCurrentUrl());
        });

        // 应用 user-agent
        if (this.settings.userAgent) {
            this.webview.useragent = this.settings.userAgent;
        }

        // 注册 webRequest 拦截器（CSP 移除 + Referer 注入）
        // 通过 partition + session.fromPartition() 获取 session，不依赖 did-attach
        // 必须在 webview 加载内容前注册，否则首批请求会漏掉
        this.stripSiteSecurityHeaders();

        this.controller.attach();

        // Chrome 扩展内容脚本注入（每次页面导航完成后由 dom-ready 触发）；
        // chrome-extension:// 整页（扩展 popup/options）另走垫片注入
        this.controller.onDomReady = (wv, url) => {
            deps.injectExtensions?.(wv, url);
            void this.maybeInjectExtensionPage(url);
        };

        // 启动 webview 健康监测：思源分屏/拖动页签会搬移 panelElement，
        // Electron webview 被重新挂载后 guest 即损坏（白屏且无响应），需自动重建
        this.startHealthMonitor();

        // SW 保活（幂等）：浏览器页签存在期间扩展 SW 常驻，popup/消息零唤醒延迟
        // （对齐 Chrome 的"事件即唤醒"；代价是 SW 进程常驻内存）
        try { (window as any).browserPlugin?.extensionHost?.startSwKeepAlive?.(); } catch {}
        // DNR 引擎暴露（统计/排查用）
        try { (window as any).browserPlugin.dnrBlocker = dnrBlocker; } catch {}

        // 异步初始化：先确保 preload 路径就绪，再加载初始 URL
        // preload 必须在 webview 第一次加载前设置，否则不生效
        this.init(initialUrl);

        // 地址栏旁的扩展图标区：初始刷一次，扩展宿主数据就绪后再刷；
        // 同一事件顺带惰性加载 DNR 广告拦截规则集（AdGuard 扩展目录，一次）
        this.onExtHostLoaded = () => {
            void this.refreshExtensionIcons();
            try {
                const host = (window as any).browserPlugin?.extensionHost;
                const list = host?.list?.() || [];
                const adg = list.find((e: any) => /adguard/i.test(e.name || ""));
                if (adg?.path) void dnrBlocker.load(adg.path);
                // SW 预唤醒（无副作用 startWorkerForScope）：页脚本的油猴引导/消息
                // 在 dom-ready 后立刻发出，SW 冷启动期（background 执行中）handlers
                // 为空 → 撞重试窗口。开页即并行唤醒，页脚本发消息时已就绪。
                for (const e of list) {
                    if (e.native && e.electronId) {
                        try { host.wakeSw(e.electronId).catch(() => {}); } catch {}
                    }
                }
                // SW 唤醒后拉一次 webRequest filter 快照（阻塞桥预筛用）
                setTimeout(() => void this.refreshWrBridge(true), 2500);
            } catch {}
        };
        window.addEventListener("sy-browser-ext-host-loaded", this.onExtHostLoaded);

        // 立即尝试一次（扩展宿主可能早已就绪，如页签恢复）
        try { this.onExtHostLoaded(); } catch {}
        this.refreshExtensionIcons();
    }

    private onExtHostLoaded: (() => void) | null = null;

    /**
     * 刷新工具栏扩展图标区：列出已启用且有 popup 的扩展。
     * 图标从扩展目录读文件转 data URL —— 主窗口是 https 页，img 直接引用
     * file:// 会被混合内容策略拦掉。
     */
    private refreshExtensionIcons(): void {
        try {
            const host = (window as any).browserPlugin?.extensionHost;
            const list = host?.listActionable?.() || [];
            const req = (window as any).require;
            const fs = req("fs");
            const path = req("path");
            const MIME: Record<string, string> = {
                ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
                ".bmp": "image/bmp", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            };
            const items = list.map((ext: any) => {
                let iconDataUrl = "";
                try {
                    if (ext.iconPath) {
                        const buf = fs.readFileSync(path.join(ext.path, ext.iconPath));
                        const mime = MIME[String(ext.iconPath).toLowerCase().replace(/^.*(\.[a-z0-9]+)$/, "$1")] || "image/png";
                        iconDataUrl = `data:${mime};base64,` + buf.toString("base64");
                    }
                } catch {}
                return {
                    id: String(ext.id),
                    // actionTitle 可能还是 __MSG_xxx__ 占位符（backfill 只处理 name/description）→ 回退已解析的 name
                    title: ext.actionTitle && !/__MSG_/.test(ext.actionTitle) ? ext.actionTitle : (ext.name || String(ext.id)),
                    iconDataUrl,
                    letter: String(ext.name || ext.id || "?").trim().charAt(0).toUpperCase(),
                };
            });
            this.toolbar.setExtensionIcons(items);
        } catch (e) {
            console.warn("[browser-plugin] 扩展图标刷新失败:", e);
        }
    }

    /**
     * 扩展右键菜单项：按产品决定不展示（扩展的 contextMenus 注册项不再收集、
     * 不再进右键菜单 —— 剪藏走扩展图标/划词入口，右键保持干净）。返回空数组
     * 即菜单无扩展区，SW 的菜单查询预热也不会触发。
     */
    private getExtMenuItems(): IExtensionMenuItem[] {
        return [];
    }

    /** 在当前浏览器标签页中加载新 URL（替换当前页，浏览器行为） */
    loadURL(url: string): void {
        this.controller.loadURL(url);
    }

    /**
     * 通过 session 的 webRequest API 移除响应头中的 CSP / X-Frame-Options，
     * 并为所有出站请求注入 Referer，避免 CDN 防盗链 403。
     * 使用 partition="persist:siyuan-browser" + session.fromPartition() 直接获取 session，
     * 不依赖 did-attach 事件，确保在 webview 内容加载前就注册好拦截器。
     */
    private stripSiteSecurityHeaders(): void {
        try {
            // 首选：@electron/remote 获取主进程 session（最可靠）；
            // 降级：webview.getWebContents()（Electron 新版本可能移除）
            const session = remoteSession(BROWSER_PARTITION) || this.webviewSessionFallback();
            if (!session?.webRequest) {
                console.warn("[browser-plugin] no session available for webRequest");
                return;
            }
            this.registerWebRequest(session);
        } catch (e) {
            console.warn("[browser-plugin] stripSiteSecurityHeaders failed:", e);
        }
    }

    /** 刷新 webRequest 阻塞桥缓存：拉取各扩展 SW 里暴露的监听器 filter 快照 */
    private async refreshWrBridge(force = false): Promise<void> {
        if (!force && Date.now() - this.wrBridgeCacheAt < 30000) return;
        this.wrBridgeCacheAt = Date.now();
        try {
            const host = (window as any).browserPlugin?.extensionHost;
            const list = host?.list?.() || [];
            const expr = "(function () { var f = self.__syWebRequestFilters || {}; var out = []; for (var ev in f) { var fs = f[ev] || []; for (var i = 0; i < fs.length; i++) { out.push({ ev: ev, urls: fs[i] ? fs[i].urls : null, types: fs[i] ? fs[i].types : null }); } } return JSON.stringify(out); })()";
            for (const e of list) {
                if (!e.native || !e.electronId) continue;
                const r = await evalInSwByElectronId(e.electronId, expr).catch(() => null);
                try {
                    const arr = JSON.parse(String(r?.value || "[]"));
                    if (Array.isArray(arr) && arr.length) this.wrBridgeCache.set(e.electronId, arr);
                    else this.wrBridgeCache.delete(e.electronId);
                } catch {}
            }
        } catch {}
    }

    /** webRequest filter 匹配（urls 通配 + types） */
    private wrFilterMatches(f: { urls: string[] | null; types: string[] | null }, url: string, rtDnr: string | null): boolean {
        try {
            if (f.types && f.types.length && (!rtDnr || !f.types.includes(rtDnr))) return false;
            if (f.urls && f.urls.length) {
                const hit = f.urls.some((pat) => {
                    try {
                        const re = new RegExp("^" + pat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
                        return re.test(url);
                    } catch { return false; }
                });
                if (!hit) return false;
            }
            return true;
        } catch { return false; }
    }

    /** webRequest 阻塞桥派发：filter 命中的扩展 SW 合成派发，收 {cancel/redirectUrl}。
     *  返回 true = 已接管（cb 由派发路径回调）；false = 无人接管，调用方继续。 */
    /** 阻塞桥派发收集：向 filter 命中的扩展 SW 合成派发，汇总 {cancel/redirectUrl}。
     *  无 cb 参与（.user.js 分支的 fire-and-forget 用）。 */
    private async dispatchWrCollect(url: string, rtDnr: string | null, details: any): Promise<{ cancel?: boolean; redirectUrl?: string } | null> {
        const tasks: Array<Promise<{ cancel?: boolean; redirectUrl?: string } | null>> = [];
        let initiator = "";
        try { initiator = String(this.webview.getURL?.() || ""); } catch {}
        for (const [eid, entries] of this.wrBridgeCache) {
            const evs = entries.filter((f) => f.ev === "onBeforeRequest" && this.wrFilterMatches(f, url, rtDnr));
            if (!evs.length) continue;
            const d = {
                url, method: String(details?.method || "GET"), type: rtDnr || "other", resourceType: rtDnr || "other",
                frameId: 0, parentFrameId: -1, requestId: String(details?.requestId || "sy-" + Date.now()),
                tabId: 1, timeStamp: Date.now(), initiator, originUrl: initiator, fromCache: !!details?.fromCache,
            };
            const expr = "(async function (detailsJson) { var details = JSON.parse(detailsJson); var entries = (self.__syWebRequestFns && self.__syWebRequestFns.onBeforeRequest) || []; var out = null; for (var i = 0; i < entries.length; i++) { try { var r = entries[i](details, function () {}); if (r && typeof r.then === 'function') { r = await Promise.race([r, new Promise(function (res) { setTimeout(function () { res(null); }, 4000); })]); } if (r && typeof r === 'object') { out = r; break; } } catch (e) {} } return out ? JSON.stringify(out) : ''; })(" + JSON.stringify(JSON.stringify(d)) + ")";
            tasks.push(evalInSwByElectronId(eid, expr).then((r) => {
                try { const parsed = JSON.parse(String(r?.value || "")); return parsed && typeof parsed === "object" ? parsed : null; } catch { return null; }
            }).catch(() => null));
        }
        if (!tasks.length) return null;
        const results = await Promise.all(tasks.map((t) => Promise.race([t, new Promise((res) => setTimeout(() => res(null), 6000))])));
        for (const r of results) {
            if (!r) continue;
            if (r.cancel || r.redirectUrl) return r;
        }
        return null;
    }

    /** 排空各扩展 SW 的 tabs.create 出箱（ask.html 等由 openUrl 真实打开） */
    private async drainWrOutbox(): Promise<void> {
        try {
            const drExpr = "(() => { const o = self.__syTabCreateOutbox || []; self.__syTabCreateOutbox = []; return JSON.stringify(o); })()";
            for (const eid of this.wrBridgeCache.keys()) {
                try {
                    const dr = await evalInSwByElectronId(eid, drExpr);
                    const items = dr && !dr.err && dr.value ? JSON.parse(String(dr.value)) : [];
                    for (const it of (Array.isArray(items) ? items : [])) {
                        const u = String((it && it.url) || "");
                        if (!u) continue;
                        if (u.includes("ask.html") || u.includes("confirm/index.html")) { const pj = this.pendingUserJs; if (pj && !pj.askOpened) pj.askOpened = true; }
                        const bp = (window as any).browserPlugin;
                        if (bp?.openUrl) bp.openUrl(u, { force: true });
                    }
                } catch {}
            }
        } catch {}
    }

    private maybeDispatchWr(url: string, rtDnr: string | null, details: any, cb: (r: any) => void): boolean {
        try {
            if (!this.wrBridgeCache.size) {
                void this.refreshWrBridge(true);
                return false; // 首请求只触发缓存刷新（SW 冷启动期 filter 尚未知）
            }
            let dispatched = false;
            for (const [, entries] of this.wrBridgeCache) {
                if (entries.some((f) => f.ev === "onBeforeRequest" && this.wrFilterMatches(f, url, rtDnr))) { dispatched = true; break; }
            }
            if (!dispatched) return false;
            // ★ 回调不能拖到 drain 之后：阻塞挂起超时会被 Chromium 以 ERR_ABORTED
            //   中止（实测 .user.js 导航 -3）。cb 只等派发汇总，drain 在回调后跑。
            void (async () => {
                try {
                    const r = await this.dispatchWrCollect(url, rtDnr, details);
                    if (r) {
                        if (r.cancel) { cb({ cancel: true }); return; }
                        if (r.redirectUrl) { cb({ redirectUrl: r.redirectUrl }); return; }
                    }
                } catch {}
                cb({});
                await this.drainWrOutbox();
            })();
            return true;
        } catch {
            return false;
        }
    }

    /** webNavigation.onCommitted 合成派发：扩展（TM 的 .user.js 安装检测等）
     *  的导航观察依赖事件流；派发后多点排空 tabs 出箱（ask.html 由 openUrl
     *  真实打开）。仅对暴露了真实事件面的扩展派发（探针预筛）。 */
    private async emitWebNavCommitted(url: string): Promise<void> {
        try {
            const host = (window as any).browserPlugin?.extensionHost;
            const list = host?.list?.() || [];
            const native = list.filter((e: any) => e.native && e.electronId);
            if (!native.length) return;
            const probe = "(function () { var f = self.__syWebNavFns || {}; return JSON.stringify({ c: (f.onCommitted || []).length }); })()";
            const dispatchExpr = "(function (d) { var fns = (self.__syWebNavFns && self.__syWebNavFns.onCommitted) || []; for (var i = 0; i < fns.length; i++) { try { fns[i](d); } catch (e) {} } return new Promise(function (res) { setTimeout(function () { res(JSON.stringify({ outbox: (self.__syTabCreateOutbox || []).map(function (x) { return String(x.url).slice(0, 90); }) })); }, 3500); }); })(" + JSON.stringify(JSON.stringify({ frameId: 0, tabId: 1, url, transitionType: "link", transitionQualifiers: [], timeStamp: Date.now() })) + ")";
            const drainExpr = "(() => { const o = self.__syTabCreateOutbox || []; self.__syTabCreateOutbox = []; return JSON.stringify(o); })()";
            for (const e of native) {
                try {
                    const chk = await evalInSwByElectronId(e.electronId, probe).catch(() => null);
                    if (!chk || !String(chk.value || "").includes('"c":')) continue;
                    if (String(chk.value).includes('"c":0')) continue; // 该扩展没挂 onCommitted
                    await evalInSwByElectronId(e.electronId, dispatchExpr).catch(() => null);
                    // 多点排空（TM handler 异步 fetch 后才 tabs.create）
                    for (const delay of [1500, 4000, 8000]) {
                        await new Promise((r) => setTimeout(r, delay === 1500 ? 1500 : delay === 4000 ? 2500 : 4000));
                        try {
                            const dr = await evalInSwByElectronId(e.electronId, drainExpr);
                            const items = dr && !dr.err && dr.value ? JSON.parse(String(dr.value)) : [];
                            for (const it of (Array.isArray(items) ? items : [])) {
                                const u = String((it && it.url) || "");
                                if (!u) continue;
                                if (u.includes("ask.html") || u.includes("confirm/index.html")) { const pj = this.pendingUserJs; if (pj && !pj.askOpened) pj.askOpened = true; }
                                const bp = (window as any).browserPlugin;
                                if (bp?.openUrl) bp.openUrl(u, { force: true });
                            }
                        } catch {}
                    }
                } catch {}
            }
        } catch {}
    }

    /** .user.js 导航 → 油猴安装：宿主拦下导航（Electron 无阻塞 webRequest，
     *  TM MV3 自己也不再有该能力），下载脚本内容并解析 ==UserScript== 头，
     *  注册进油猴扩展的 userScripts 注册表（垫片持久化，宿主注入器自动在
     *  匹配页面执行）。@grant none 类脚本完整可用；带 GM_* 的脚本受限于
     *  TM 未知其记录，GM 调用暂不可用（v1 权衡）。 */
    private async interceptUserScriptInstall(url: string, resourceType: string, cb: (r: any) => void): Promise<void> {
        cb({ cancel: true });
        try {
            const host = (window as any).browserPlugin?.extensionHost;
            if (!host?.list) {
                console.warn("[browser-plugin] .user.js 拦截: extensionHost 缺 list");
                return;
            }
            const tm = host.list().find((e: any) => /tampermonkey|篡改猴/i.test(String(e.name || "")) && e.electronId && e.native);
            if (!tm) {
                const vm = host.list().find((e: any) => /violentmonkey|暴力猴/i.test(String(e.name || "")) && e.electronId && e.native);
                if (!vm) {
                    showMessage("未找到油猴扩展，无法安装脚本", 4000, "error");
                    return;
                }
                // VM 自有安装链（webRequest 观察者 + confirm/index.html#key 页）：
                // 走到这里 = 9s 窗口内 VM 链条未走出 confirm（其 SW fetch 常慢于窗口）。
                // 再给一轮合成下载事件 + wr 派发 + 多点排空，confirm 出现即止；
                // 仍失败才按实际装的管理器提示。
                showMessage("已交给 Violentmonkey 处理安装…", 3000, "info");
                console.info("[browser-plugin] .user.js 交由 VM 安装链重试:", url.slice(0, 80));
                void (async () => {
                    try {
                        await evalInSwByElectronId(vm.electronId, `try { self.__syEmitDownload && self.__syEmitDownload(${JSON.stringify(url)}); } catch (e) {}`).catch(() => null);
                        this.pendingUserJs = { url, askOpened: false };
                        try { await this.dispatchWrCollect(url, "main_frame", { url, resourceType: "mainFrame", type: "mainFrame" }); } catch {}
                        for (const delay of [1500, 3000, 5000, 7000]) {
                            await new Promise((r) => setTimeout(r, delay));
                            await this.drainWrOutbox();
                            if (this.pendingUserJs && this.pendingUserJs.askOpened) { console.info("[browser-plugin] .user.js VM confirm 已打开"); break; }
                        }
                        if (this.pendingUserJs && this.pendingUserJs.url === url && !this.pendingUserJs.askOpened) {
                            showMessage("Violentmonkey 安装页未打开（脚本源不可达或网络代理未开）", 5000, "error");
                        }
                        if (this.pendingUserJs && this.pendingUserJs.url === url) this.pendingUserJs = null;
                    } catch {}
                })();
                return;
            }
            // 下载脚本内容：★ 必须走浏览器分区的 session.fetch（代理/cookie 与
            // 页面一致）——渲染进程默认 fetch 走思源会话，实测 update/greasyfork
            // 全部超时而分区网络正常。update 域失败时镜像到主站 code 路径。
            const ses = (() => {
                try { return (this.webview as any)?.getWebContents?.()?.session || null; } catch { return null; }
            })() || remoteSession(BROWSER_PARTITION);
            const fetchVia = async (u: string, ms: number): Promise<string> => {
                // ★ ses.fetch（Electron net）不接受 AbortSignal——用 Promise.race
                //   超时放弃慢请求（后台连接自行终止即可）
                const doReq = async (): Promise<string> => {
                    const r = ses && ses.fetch ? await ses.fetch(u, { credentials: "include" }) : await fetch(u, { credentials: "include" });
                    if (!r.ok) throw new Error("HTTP " + r.status);
                    return await r.text();
                };
                let timer: any = null;
                const timeoutP = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("fetch 超时 " + ms + "ms")), ms); });
                try { return await Promise.race([doReq(), timeoutP]); } finally { clearTimeout(timer); }
            };
            let code = "";
            try {
                code = await fetchVia(url, 15000);
                console.info("[browser-plugin] .user.js fetched:", url.slice(0, 60), "len:", code.length);
            } catch (e1) {
                console.warn("[browser-plugin] .user.js fetch 失败，尝试镜像:", url.slice(0, 60), String(e1?.message || e1).slice(0, 80));
                // greasyfork 的 update 域直连常见超时：镜像到主站 code 路径
                const m = url.match(/^https?:\/\/update\.greasyfork\.org\/scripts\/(\d+)\/([^/?#]+\.user\.js)$/i);
                if (!m) throw e1;
                code = await fetchVia("https://greasyfork.org/scripts/" + m[1] + "/code/" + m[2], 15000);
                console.info("[browser-plugin] .user.js 镜像 fetched: len:", code.length);
            }
            const USERSCRIPT_HEAD = new RegExp("==\\s*UserScript\\s*==");
            if (!USERSCRIPT_HEAD.test(code)) throw new Error("内容缺少 ==UserScript== 头，不是用户脚本");
            const meta = (k: string): string => {
                const m = code.match(new RegExp("//\\s*@" + k + "\\s+([^\\r\\n]+)", "i"));
                return m ? m[1].trim() : "";
            };
            const fname = decodeURIComponent((url.split("?")[0].split("/").pop() || "")).replace(/\.user\.js$/i, "");
            const name = meta("name") || fname || "userscript";
            const version = meta("version");
            const author = meta("author");
            const description = meta("description");
            const matches: string[] = [];
            const re = new RegExp("//\\s*@(match|include)\\s+([^\\r\\n]+)", "gi");
            let mm: RegExpExecArray | null;
            while ((mm = re.exec(code))) {
                const pat = mm[2].trim();
                if (pat && !matches.includes(pat)) matches.push(pat);
            }
            if (!matches.length) matches.push("*://*/*");
            // ★ 已安装检测：先跑纯宿主侧的直装副本比对（无 SW 依赖），再查 TM
            //   存储 @source/@uid（SW eval 曾观测到挂起，加 5s 限时——命中提示
            //   「已安装」跳过确认框，防冗余副本）
            const normSrc = (s: unknown) => String(s || "").replace(/\r\n/g, "\n").trim();
            console.info("[browser-plugin] .user.js 解析完成:", name, version || "-", "checks 开始");
            try {
                const regs = host.usInjector?.regs instanceof Map ? host.usInjector.regs : null;
                if (regs) {
                    for (const [, m] of regs) {
                        for (const [, entry] of m) {
                            if (!/^sy-install/.test(String(entry?.id || ""))) continue;
                            const c0 = (entry.js && entry.js[0] && entry.js[0].code) || "";
                            if (c0 && normSrc(c0) === normSrc(code)) {
                                showMessage("该脚本已安装，无需重复安装: " + name, 4000, "info");
                                return;
                            }
                        }
                    }
                }
            } catch {}
            try {
                const expr = "(async () => { const all = await new Promise(res => chrome.storage.local.get(null, res)); " +
                    "const out = []; for (const k in all) { " +
                    "if (k.indexOf('!extdb.@source#') === 0) out.push({ src: (all[k] && all[k].value) || '' }); " +
                    "if (k.indexOf('!extdb.@uid#') === 0) out.push({ uid: (all[k] && all[k].value) || '' }); } " +
                    "return JSON.stringify(out); })()";
                const r = await Promise.race([
                    evalInSwByElectronId(tm.electronId, expr),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("已安装检测超时")), 5000)),
                ]);
                const entries = JSON.parse(String(r?.value || "[]"));
                const sameSource = entries.some((x: any) => x.src !== undefined && normSrc(x.src) === normSrc(code));
                const sameName = entries.some((x: any) => x.uid !== undefined && String(x.uid).trim() === name);
                console.info("[browser-plugin] .user.js TM 存储比对:", JSON.stringify({ sameSource, sameName }));
                if (sameSource || sameName) {
                    showMessage("该脚本已安装，无需重复安装: " + name, 4000, "info");
                    return;
                }
            } catch {}
            console.info("[browser-plugin] .user.js checks 完成，未命中已安装 → 弹确认框");
            // 确认弹窗（对齐 TM ask.html 语义）：展示脚本信息，用户点安装才注册
            const aid = "aid-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
            this.pendingInstalls.set(aid, {
                url,
                code,
                name,
                version,
                author,
                description,
                matches,
                electronId: tm.electronId,
                extName: tm.name,
            });
            // 防重入：同脚本 3 分钟内不重复弹（文本页留在地址栏，重建/恢复/刷新
            // 会重新触发导航）；已有弹窗打开时也不叠加
            const dkey = url.split("?")[0];
            const lastShown = this.installDialogShownAt.get(dkey) || 0;
            if (Date.now() - lastShown < 3 * 60 * 1000) {
                console.info("[browser-plugin] .user.js 确认弹窗 3 分钟内已展示过，跳过:", dkey.slice(0, 80));
                this.pendingInstalls.delete(aid);
                return;
            }
            // 清理已脱离 DOM 的旧弹窗：webview 重建/页签搬移会把 overlay 连带 DOM
            // 一起换掉，残引用会让「已有打开实例」永久为真 —— 后续所有安装确认
            // 被静默跳过（实测 .user.js 弹窗一泄漏就再也装不上）
            for (const ov of [...this.pendingInstallDialogs]) {
                if (!ov.isConnected) this.pendingInstallDialogs.delete(ov);
            }
            if (this.pendingInstallDialogs.size > 0) {
                console.info("[browser-plugin] .user.js 确认弹窗已有打开实例，跳过叠加");
                this.pendingInstalls.delete(aid);
                return;
            }
            this.installDialogShownAt.set(dkey, Date.now());
            if (this.installDialogShownAt.size > 50) {
                const oldest = this.installDialogShownAt.keys().next().value;
                if (oldest !== undefined) this.installDialogShownAt.delete(oldest);
            }
            this.showInstallDialog(aid, { name, version, author, description, matches, from: url });
        } catch (e) {
            console.warn("[browser-plugin] .user.js 安装失败:", e);
            showMessage("安装脚本失败: " + (e instanceof Error ? e.message : e), 5000, "error");
        }
    }

    /** 安装确认弹窗（宿主侧 DOM，对齐 TM ask.html 的确认语义） */
    private showInstallDialog(aid: string, info: { name: string; version: string; author: string; description: string; matches: string[]; from: string }): void {
        const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const overlay = document.createElement("div");
        overlay.className = "sy-us-install-overlay";
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;";
        const rows: Array<[string, string]> = [
            ["名称", info.name],
            ["版本", info.version || "（未声明）"],
            ["作者", info.author || "（未声明）"],
            ["描述", info.description || "（未声明）"],
            ["运行于", info.matches.join("、")],
        ];
        overlay.innerHTML =
            '<div class="sy-us-install-card" style="background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.3);width:420px;max-width:92vw;padding:18px 20px;font-size:13px;color:#333;">'
            + '<div style="font-size:15px;font-weight:600;margin-bottom:10px;">安装用户脚本</div>'
            + rows.map(([k, v]) => '<div style="display:flex;gap:8px;margin:4px 0;"><div style="flex:0 0 52px;color:#888;">' + k + '</div><div style="flex:1;word-break:break-all;">' + esc(v) + "</div></div>").join("")
            + '<div style="margin:10px 0 0;color:#888;font-size:12px;">来源: ' + esc(info.from.slice(0, 90)) + "</div>"
            + '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">'
            + '<button data-act="cancel" style="padding:6px 16px;border-radius:6px;border:1px solid #ddd;background:#f5f5f5;cursor:pointer;">取消</button>'
            + '<button data-act="install" style="padding:6px 18px;border-radius:6px;border:none;background:#1a73e8;color:#fff;cursor:pointer;font-weight:600;">安装</button>'
            + "</div></div>";
        const close = () => { try { overlay.remove(); } catch {} };
        this.pendingInstallDialogs.add(overlay);
        overlay.addEventListener("click", (ev) => {
            const btn = (ev.target as HTMLElement).closest("button[data-act]");
            if (!btn) {
                if (ev.target === overlay) close(); // 点遮罩 = 取消
                return;
            }
            const act = btn.getAttribute("data-act");
            close();
            this.pendingInstallDialogs.delete(overlay);
            if (act !== "install") return;
            void this.confirmInstall(aid);
        });
        this.element.appendChild(overlay);
        console.info("[browser-plugin] .user.js 确认弹窗已展示:", info.name);
    }

    /** 用户确认后的注册（原直装逻辑后移至此） */
    private async confirmInstall(aid: string): Promise<void> {
        const pending = this.pendingInstalls.get(aid);
        if (!pending) {
            // aid 失联（tab 重建换了实例等）——给用户可见反馈而非静默
            showMessage("安装会话已失效，请重新点击「安装此脚本」", 4000, "error");
            return;
        }
        this.pendingInstalls.delete(aid);
        const { code, name, matches, electronId: electronId } = pending;
        try {
            const id = "sy-install-" + Date.now().toString(36);
            const tryRegister = async (m: string[]): Promise<string> => {
                // ★ 归一非标准通配：TM 系 @match 允许 `*://**/*`（host `**`），
                //   标准 match pattern 不认 —— 存进注册表后 matches 永不命中，
                //   脚本静默不注入（实测 SEJ 直装副本失效）。`**` 视同任意主机。
                const normMatches = m.map((p) => /:\/\/\*\*(?:[/?#]|$)/.test(p) ? p.replace("://**/", "://*/").replace("://**", "://*") : p);
                const script = { id, matches: normMatches, js: [{ code }], world: "USER_SCRIPT", runAt: "document_idle" };
                // ★ 传参是 JSON 字符串，SW 侧必须先 JSON.parse —— 否则 register
                //   收到 string，s.id undefined 被守卫跳过，还报 "ok"（实测踩坑）
                const expr = "(function (scriptJson) { try { var script = JSON.parse(scriptJson); chrome.userScripts.register(script, function () {}); return 'ok'; } catch (e) { return 'throw:' + e.message; } })(" + JSON.stringify(JSON.stringify(script)) + ")";
                const r = await evalInSwByElectronId(electronId, expr);
                return String(r?.value || "");
            };
            let reg = await tryRegister(matches);
            if (reg !== "ok") {
                // match pattern 不合法（@include 通配等）→ 兜底 <all_urls>
                reg = await tryRegister(["<all_urls>"]);
            }
            if (reg !== "ok") {
                showMessage("安装脚本失败: " + reg.replace("throw:", ""), 5000, "error");
                return;
            }
            console.info("[browser-plugin] 油猴脚本已安装:", name, "matches:", matches.join(" "));
            showMessage("已安装油猴脚本: " + name, 4000, "info");
        } catch (e) {
            console.warn("[browser-plugin] .user.js 安装失败:", e);
            showMessage("安装脚本失败: " + (e instanceof Error ? e.message : e), 5000, "error");
        }
    }

    private webviewSessionFallback(): any | null {
        try {
            const wv: any = this.webview;
            return wv?.getWebContents?.()?.session || null;
        } catch {
            return null;
        }
    }

    private registerWebRequest(session: any): void {
        // 0. 网络层拦截：①webRequest 阻塞桥（扩展监听器 filter 命中才派发，
        //    TM 的 .user.js 安装由此原生走通）；②.user.js 宿主直装兜底；
        //    ③DNR 规则引擎（AdGuard 官方规则集，惰性加载）。
        session.webRequest.onBeforeRequest((details: any, cb: (r: any) => void) => {
            try {
                const url = details?.url || "";
                if (/^chrome-extension:/i.test(url) || /^data:/i.test(url)) { cb({}); return; }
                const RT_MAP: Record<string, string> = { mainFrame: "main_frame", subFrame: "sub_frame", xhr: "xmlhttprequest", cspReport: "csp_report", webSocket: "websocket" };
                const rtDnr = RT_MAP[String(details?.resourceType || "")] || String(details?.resourceType || "") || null;
                // ★ .user.js 拦截：cancel 导航 + 9s 回落宿主确认弹窗。
                //   曾尝试真浏览器流程（放行导航让 TM 引导检测 .user.js），但实测
                //   update.greasyfork.org 在 webview 会话里加载挂死（SW fetch 与
                //   curl-via-proxy 均 2s 返回，唯独 webview 导航无响应——会话级
                //   待查），页面 90s 卡死触发重建循环。故维持 cancel + 宿主直装
                //   （fetch 走 session.fetch + 镜像兜底，实测可装）。
                //   后续线索：SW fetch 同 URL 200/2s，唯 webview 导航挂——对比
                //   两者请求头/代理行为可定位。
                if (/\.user\.js(?:[?#]|$)/i.test(url) && details?.resourceType === "mainFrame" && !/^chrome-extension:/i.test(url) && !/script_installation\.php/i.test(url)) {
                    cb({ cancel: true });
                    this.pendingUserJs = { url, askOpened: false };
                    // ★ 合成 downloads.onCreated：TM 的安装入口是下载事件（真 Chrome
                    //   把 .user.js 当下载，TM 观察后自己 fetch URL/登记待装/tabs.create
                    //   开 ask.html）。只派发 webRequest 不会触发其安装流——实测缺这步
                    //   TM 链条 20s 静默超时回落、__syDownloadItems 恒空。对全部原生
                    //   扩展合成（downloads.onCreated 只有 TM 注册，其余扩展无感）。
                    void (async () => {
                        try {
                            const eh = (window as any).browserPlugin?.extensionHost;
                            const exts = (eh?.list?.() || []).filter((e: any) => e.native && e.electronId);
                            for (const e of exts) {
                                await evalInSwByElectronId(e.electronId, `try { self.__syEmitDownload && self.__syEmitDownload(${JSON.stringify(url)}); } catch (e) {}`).catch(() => null);
                            }
                        } catch {}
                    })();
                    // 合成下载事件保留：TM 若在授予 downloads 可选权限后启用
                    // downloads.onCreated 检测，此事件立即可用（当前监听数 0，无感）。
                    void (async () => {
                        try { await this.dispatchWrCollect(url, rtDnr, details); } catch {}
                        for (const delay of [1500, 2500, 4000]) {
                            await new Promise((r) => setTimeout(r, delay));
                            await this.drainWrOutbox();
                        }
                    })();
                    // TM 链条 9s 未走出 ask → 回落宿主确认弹窗（TM 原生链需要 tab
                    // 注册表配合，当前环境多数情况走不到 ask —— 9s 已够其 fetch+登记，
                    // 再等只是让用户干等；宿主弹窗带元数据与已安装检测，体验完整）
                    setTimeout(() => {
                        const pj = this.pendingUserJs;
                        if (pj && pj.url === url && !pj.askOpened) {
                            console.info("[browser-plugin] .user.js TM 链条未完成，回落宿主确认安装:", url.slice(0, 80));
                            void this.interceptUserScriptInstall(url, "mainFrame", () => {});
                        }
                        if (this.pendingUserJs && this.pendingUserJs.url === url) this.pendingUserJs = null;
                    }, 9000);
                    return;
                }
                if (this.maybeDispatchWr(url, rtDnr, details, cb)) return;
                if (dnrBlocker.shouldBlock(url, details?.resourceType, details?.referrer || "")) {
                    cb({ cancel: true });
                    return;
                }
            } catch {}
            cb({});
        });
        // 1. 响应头：移除站点安全限制（CSP / X-Frame-Options）
        session.webRequest.onHeadersReceived((details: any, cb: (r: any) => void) => {
            try {
                // Electron 的 responseHeaders 是 Record<string, string[]>；
                // 之前把值再包一层数组 → 嵌套数组（Set-Cookie 等多值头被写坏，
                // cookie 反复累积后请求头爆掉 → IIS 400 "Header Field Too Long"）
                const out: Record<string, string[]> = {};
                if (details?.responseHeaders) {
                    for (const key of Object.keys(details.responseHeaders)) {
                        const lower = key.toLowerCase();
                        if (lower === "content-security-policy"
                            || lower === "content-security-policy-report-only"
                            || lower === "x-frame-options") continue;
                        const v = details.responseHeaders[key];
                        out[key] = Array.isArray(v) ? v : [String(v)];
                    }
                }
                cb({ responseHeaders: out });
            } catch {
                cb({});
            }
        });
        // 2. 请求头：商店域名 UA 伪装 + Referer 注入（绕过 CDN 防盗链）
        //    站点 CDN 检测到空 Referer 会返回 403（X-Error-Info: EmptyReferer）
        session.webRequest.onBeforeSendHeaders((details: any, cb: (r: any) => void) => {
            const reqUrl = details.url || "";
            if (!/^https?:\/\//i.test(reqUrl)) {
                cb({});
                return;
            }
            try {
                const headers: Record<string, string> = {};
                if (details?.requestHeaders) {
                    for (const k of Object.keys(details.requestHeaders)) {
                        const v = details.requestHeaders[k];
                        headers[k] = Array.isArray(v) ? String(v[0]) : String(v);
                    }
                }
                // 2a) UA：商店域名伪装 Edge（webview 的 setUserAgent 需要 attach+dom-ready，
                //     首导航请求的 UA 头只能在这里改 —— 不依赖 webview 就绪状态）
                const ua = this.uaForRequest(reqUrl);
                if (ua) headers["User-Agent"] = ua;
                // 2b) Referer：已有合法 http(s) referer → 不改
                const referrer = details.referrer || "";
                if (!(referrer && /^https?:\/\//i.test(referrer))) {
                    // 用当前 webview URL 作为 Referer
                    const current = this.webview.getURL?.() || "";
                    let refUrl = "";
                    if (current && /^https?:\/\//i.test(current)) {
                        refUrl = current;
                    }
                    if (!refUrl) {
                        const target = new URL(reqUrl);
                        refUrl = target.origin + "/";
                    }
                    headers["Referer"] = refUrl;
                }
                cb({ requestHeaders: headers });
            } catch {
                cb({});
            }
        });
        console.log("[browser-plugin] webRequest registered (CSP strip + referer inject)");
    }

    private async init(initialUrl?: string): Promise<void> {
        console.log("[browser-plugin] BrowserTab.init, initialUrl:", initialUrl);
        // 显式 URL（含恢复的页签 data.url）优先；无 URL 时按「新标签页扩展」设置解析
        // （配置了新标签页扩展则加载其 newtab 页，否则主页）
        const start = initialUrl || this.deps.resolveStartUrl?.() || this.settings.homepage || "about:blank";
        if (start && start !== "about:blank") {
            // 先切好 UA 再发首次请求（商店域名需伪装 Edge，否则页内禁用「获取」按钮）
            this.syncUserAgent(start);
            // 先加载 URL（不等 preload，preload 只影响后续页内链接拦截）
            console.log("[browser-plugin] loading URL:", start);
            this.controller.loadURL(start);
        } else {
            console.log("[browser-plugin] skipping load (start is empty or about:blank)");
        }
        // 异步设置 preload（不阻塞首次加载；对后续导航生效）
        this.applyPreload();
    }

    /** 请求级 UA（webRequest 层用，不依赖 webview 就绪状态）：
     *  商店域名恒伪装 Edge；其余仅在用户自定义 UA 时注入（无自定义时不动 UA，
     *  让 Chromium 自带默认 —— 此时 defaultUserAgent 可能尚未捕获，注入会污染）。 */
    private uaForRequest(reqUrl: string): string | null {
        try {
            if (isEdgeAddonsSiteUrl(reqUrl)) return EDGE_UA;
            return this.settings.userAgent || null;
        } catch {
            return null;
        }
    }

    /**
     * 按目标 URL 切换 webview UA。
     * Edge 加载项商店会 UA 嗅探：非 Edge 浏览器直接禁用「获取」按钮并提示
     * "与你的浏览器不兼容"，因此在商店域名下伪装 Edge UA，离开后恢复
     * （自定义 UA 优先，否则用 Electron 默认）。
     *
     * 必须用 webContents.setUserAgent()：<webview useragent="..."> 属性在
     * Electron 44（思源 3.8.6 自带）下**实测无效** —— 属性读得回正确值，
     * 但页内 navigator.userAgent 始终是 Electron 默认的
     * "…SiYuan/3.8.6 Chrome/152…Electron/44.4.5…"，reload 也不变。
     * 走 webContents 则立即生效（含当前已加载页面）。
     */
    private syncUserAgent(url: string): void {
        try {
            const isStore = isEdgeAddonsSiteUrl(url);
            if (!isStore && !this.edgeUaActive) return;
            // webview 未入 DOM 或尚未 dom-ready 时所有 webview 方法都抛
            // "The WebView must be attached to the DOM and the dom-ready event
            // emitted..."（构造期由思源 addTab 同步路径调到这里必中）。
            // 此时无法也不需要设置：首次导航完成触发 onUrlChange 会再调本方法补上，
            // 首请求的 UA 头由 webRequest 拦截器（stripSiteSecurityHeaders）兜底。
            if (!this.webview.isConnected || typeof (this.webview as any).getWebContentsId !== "function") return;
            if (typeof (this.webview as any).getWebContentsId?.() !== "number") return;
            if (!this.defaultUserAgent) {
                this.defaultUserAgent =
                    (this.webview as any).getUserAgent?.() ||
                    (window as any).navigator?.userAgent ||
                    "";
            }
            const ua = isStore ? EDGE_UA : this.settings.userAgent || this.defaultUserAgent;
            this.edgeUaActive = isStore;
            if (ua && this.appliedUserAgent !== ua) {
                const wc = this.webContents();
                if (wc?.setUserAgent) {
                    wc.setUserAgent(ua);
                    this.appliedUserAgent = ua;
                    console.log("[browser-plugin] webview UA ->", isStore ? "Edge (store)" : "default/custom");
                } else {
                    // 拿不到 webContents：退回属性方式，至少 HTTP 头可能生效
                    this.webview.setAttribute("useragent", ua);
                    try {
                        (this.webview as any).useragent = ua;
                    } catch {}
                    this.appliedUserAgent = ua;
                    console.log("[browser-plugin] webview UA (attr fallback) ->", isStore ? "Edge (store)" : "default/custom");
                }
            }
        } catch (e) {
            console.warn("[browser-plugin] syncUserAgent failed:", e);
        }
    }

    /** 取 webview 对应的 webContents（经 @electron/remote）；拿不到返回 null */
    private webContents(): any | null {
        try {
            const req = (window as any).require;
            const remote = req?.("@electron/remote");
            if (!remote?.webContents?.fromId) return null;
            const id = (this.webview as any).getWebContentsId?.();
            if (typeof id !== "number") return null;
            return remote.webContents.fromId(id);
        } catch {
            return null;
        }
    }

    /**
     * 在当前页内弹出扩展 popup 面板。
     * 面板执行上下文就是目标页本身，popup 里的 chrome.tabs.query 返回本页、
     * sendMessage 能被本页 content script 收到 —— 与真 Chrome 行为一致。
     */
    async openExtensionPopup(extId: string, anchor?: HTMLElement): Promise<void> {
        const host = (window as any).browserPlugin?.extensionHost;
        const ext = host?.list?.().find((e: any) => e.id === extId);
        if (!ext) {
            showMessage("扩展不存在或已被卸载", 3000, "error");
            return;
        }
        if (!ext.native || !ext.electronId) {
            showMessage("该扩展未以原生模式加载，无法弹出面板", 4000, "error");
            return;
        }
        if (!ext.popupPath) {
            showMessage(`「${ext.name}」没有 popup 面板`, 4000, "info");
            return;
        }
        // Chrome 式 toggle：同一扩展已开 → 再点即关；其他扩展已开 → 切换文档。
        // overlay 常温（关闭 = 隐藏 + 归位 about:blank，进程/缓存温热，无孤儿元素）。
        if (this.extPopup?.isOpenFor(extId)) {
            this.extPopup.close();
            return;
        }
        // 预热 SW：面板脚本的首个 storage 调用若撞上 SW 冷启动会挂到超时（Clip 无重试
        // 逻辑 → 面板全白"点不开"）。唤醒并行完成。
        try {
            const wakeP = (window as any).browserPlugin?.extensionHost?.wakeSw?.(ext.electronId);
            if (wakeP) await Promise.race([wakeP, new Promise((r) => setTimeout(r, 2500))]);
        } catch {}
        // anchor 缺省（如从思源顶栏触发）：面板落在右上角
        const r = anchor
            ? anchor.getBoundingClientRect()
            : ({ right: (window.innerWidth || 1200) - 24, bottom: 48 } as DOMRect);
        // TM 的 popup 自己不调 chrome.tabs.query，靠 SW 侧 getSelected 解析当前
        // 页签 —— 宿主主动喂一次 tabevent（喂的是"面板锚定的页签"，即本页）。
        // 必须等喂完再放行面板：loadTree 会在面板 JS 启动后立刻发出，抢跑的话
        // SW 侧活动页签还是空 → 面板无 tab 上下文（no access）。限时防挂。
        try {
            const curUrl = String(this.webview.getURL?.() || "");
            const curTitle = String((this.webview as any).getTitle?.() || document.title || "");
            if (/^https?:\/\//i.test(curUrl)) {
                await Promise.race([
                    feedTabEventForPopup(this.webview, {
                        electronId: ext.electronId,
                        path: ext.path,
                        name: ext.name,
                        version: ext.version,
                        defaultLocale: ext.defaultLocale,
                        contentScripts: ext.contentScripts,
                        senderPageUrl: "chrome-extension://" + ext.electronId + "/" + String(ext.popupPath).replace(/^\.\//, ""),
                    }, curUrl, curTitle),
                    new Promise((r2) => setTimeout(r2, 3000)),
                ]);
            }
        } catch {}
        if (!this.extPopup) {
            this.extPopup = new ExtensionPopupOverlay(this.element, {
                onClosed: (closedExtId) => {
                    console.info("[browser-plugin] popup closed:", closedExtId);
                },
                onError: (msg) => showMessage(msg, 5000, "error"),
            });
            this.extPopup.installGlobalListeners();
        }
        this.extPopup.open({
            extId,
            anchorRect: { right: r.right, bottom: r.bottom },
            extPath: ext.path,
            electronId: ext.electronId,
            popupPath: ext.popupPath,
            name: ext.name,
            version: ext.version,
            defaultLocale: ext.defaultLocale,
            contentScripts: ext.contentScripts,
            optionsPath: (ext as any).optionsPath,
            userAgent: this.settings.userAgent,
            // 锚定页：overlay 真实源架构下垫片世界 tabs.query 的"当前页签"
            // （不传则 AdGuard 的 tab 上下文塌成扩展页 → 弹窗端口回包永空）
            anchorTab: {
                url: String(this.webview.getURL?.() || ""),
                title: String((this.webview as any).getTitle?.() || document.title || ""),
            },
        });
    }

    /**
     * webview 导航到本插件管理的 chrome-extension:// 页面时（如从思源顶栏
     * 无浏览器 tab 场景 openUrl 直开的扩展 popup/options），注入扩展专属
     * 世界垫片并重放页面脚本 —— 否则页面脚本跑在 Electron 原生受限主世界，
     * sendMessage/storage 全部失败，AdGuard 等会永远停在 loading 动画。
     */
    private async maybeInjectExtensionPage(url: string): Promise<void> {
        try {
            // loadURL 改道（chrome-extension:// 不原生加载）落地的 about:blank：
            // 换成改道目标 URL 继续注入（pendingExtPageUrl 由 WebviewController.loadURL
            // 设置，离开扩展页时清空）
            if ((!url || /^about:blank$/i.test(url)) && this.controller.pendingExtPageUrl) {
                url = this.controller.pendingExtPageUrl;
            }
            if (!url || !/^chrome-extension:\/\//i.test(url)) return;
            const m = url.match(/^chrome-extension:\/\/([^/?#\s]+)(\/[^?#]*)?/i);
            if (!m) return;
            const electronId = m[1];
            const pagePath = (m[2] || "/").slice(1);
            if (!pagePath) return;
            const host = (window as any).browserPlugin?.extensionHost;
            const ext = host?.list?.().find((e: any) => e.electronId === electronId && e.native);
            if (!ext) return; // 非本插件管理的扩展（或未原生加载）—— 交给 Electron 原生
            const extInfo = {
                electronId: ext.electronId,
                path: ext.path,
                name: ext.name,
                version: ext.version,
                defaultLocale: ext.defaultLocale,
                contentScripts: ext.contentScripts,
                // 与 popup 路径同理由：SW 侧按 sender.url 判 extpage 白名单
                //（TM loadTree 等 allow 门禁 `mp(t)&&("options"==t.extpage||…)`，
                // 改道重建场景页面真实 URL 是 about:blank → sender 塌成 about:blank
                // → 门禁拒绝 → sendMessage 回布尔 false → TM 引导走 fail → confirm）。
                // 必须以扩展页 URL 身份发包（含 hash 保留深链语义）。
                senderPageUrl: url,
            };
            const out = await (async () => {
                this.extPageInjecting = true;
                try {
                    return await injectExtensionPageRuntime({
                        webview: this.webview,
                        extPath: ext.path,
                        electronId: ext.electronId,
                        pagePath,
                        // 改道重建场景页面真实 location 是 about:blank，TM 等按
                        // pathname 分派引导分支会静默空转 —— 伪装成目标 URL
                        // 真实源原生加载（2026-10-31 起 options 页与 popup 同架构）：
                        // location 语义已原生正确，跳过伪装；about:blank/chrome-error
                        // 兜底路径才需要（TM 等按 pathname 分派引导分支，真实
                        // location 是 about:blank 会静默空转）
                        spoofLocationUrl: /^chrome-extension:\/\//i.test((() => {
                            try { return this.webview.getURL?.() || ""; } catch { return ""; }
                        })()) ? undefined : url,
                        // 页面 DOM 是否原生存在不能按 URL 判断（dom-ready 时 getURL()
                        // 与实际文档可能错位）—— 直接探页面实际 DOM：空页即重建。
                        // about:blank 兜底文档（不透明源）→ localStorage 垫片种子照传
                        //（原生真源文档垫片不装，种子自动闲置；写入经 webview ipc
                        // 回灌宿主，见 WebviewController ipc-message 监听）
                        lsSeed: readExtLsSeed(electronId),
                        rebuildDom: await (async () => {
                            try {
                                const len = await this.webview.executeJavaScript(
                                    "(document.body ? document.body.innerHTML.length : -1)", false);
                                return typeof len !== "number" || len < 10;
                            } catch { return true; }
                        })(),
                        begin: () => beginPopupWorld(this.webview, extInfo),
                        evalJs: (src, relPath) => {
                            const fakeUrl = "chrome-extension://" + ext.electronId + "/" + String(relPath).replace(/^\.\//, "");
                            const prefixed =
                                "self.__sySetCurrentScript && self.__sySetCurrentScript(" + JSON.stringify(fakeUrl) + ");\n" + src;
                            return evalPopupJs(this.webview, extInfo, prefixed).then((rr) => {
                                if (!rr.ok) throw new Error(rr.error);
                                return rr.value;
                            });
                        },
                    });
                } finally {
                    this.extPageInjecting = false;
                }
            })();
            if (!out.ok) {
                console.warn("[browser-plugin] 扩展页面垫片注入失败(" + pagePath + "):", out.error);
            } else {
                console.log("[browser-plugin] 扩展页面垫片已注入:", pagePath, "scripts:", out.scripts);
            }
        } catch (e) {
            console.warn("[browser-plugin] maybeInjectExtensionPage failed:", e);
        }
    }

    /** 从插件主实例获取 preload 路径并应用到 webview */
    private async applyPreload(): Promise<void> {
        if (!this.settings.enablePreload) {
            console.warn("[browser-plugin] preload disabled by setting (enablePreload=false)");
            return;
        }
        try {
            const plugin = (window as any).browserPlugin as any;
            if (!plugin?.getPreloadPath) return;
            const preloadUrl = await plugin.getPreloadPath();
            if (!preloadUrl) {
                console.warn("[browser-plugin] preload path not detected, link interception disabled");
                return;
            }
            // 同时用 setAttribute 和属性赋值，最大化兼容性
            this.webview.setAttribute("preload", preloadUrl);
            try {
                this.webview.preload = preloadUrl;
            } catch {}
            // 验证是否设置成功
            const actual = this.webview.getAttribute("preload") || (this.webview as any).preload;
            if (actual) {
                console.log("[browser-plugin] preload applied:", actual);
            } else {
                console.warn("[browser-plugin] preload setAttribute failed silently");
            }
        } catch (e) {
            // 路径探测失败时静默忽略，webview 仍能加载页面（只是失去新窗口拦截）
            console.warn("[browser-plugin] applyPreload failed:", e);
        }
    }

    private buildDom(): HTMLElement {
        const root = el("div", "sy-browser-tab");
        const content = el("div", "sy-browser-content");
        content.appendChild(this.createWebviewElement() as unknown as HTMLElement);
        root.appendChild(content);
        return root;
    }

    /**
     * 创建 webview 元素。
     * webpreferences: 允许 preload 中 require('electron')（contextIsolation 关闭）
     *   允许 sub-frame nodeIntegration（preload 注入子框架）
     *   允许加载本地文件（webSecurity 不关闭，避免破坏站点 CSS/CSP）
     * 分屏/拖动导致 webview 损坏时，重建也走这里保证属性一致。
     */
    private createWebviewElement(): IWebviewTag {
        const webview = document.createElement("webview") as unknown as IWebviewTag;
        webview.setAttribute("src", "about:blank");
        webview.setAttribute("allowpopups", "");
        webview.setAttribute("partition", BROWSER_PARTITION);
        webview.setAttribute("webpreferences", "contextIsolation=no,nodeIntegrationInSubFrames=yes");
        // 在构建 webview 时立即设置 preload（若路径已缓存），确保首次加载就生效
        try {
            const plugin = (window as any).browserPlugin as any;
            const cached = plugin?.getPreloadPathSync?.();
            if (cached && this.settings.enablePreload) {
                webview.setAttribute("preload", cached);
            }
        } catch {}
        (webview as unknown as HTMLElement).style.cssText = "flex:1;width:100%;border:0;";
        return webview;
    }

    /** 启动 webview 健康监测（损坏自动重建） */
    /** guest 存活判定：webview 重建/未挂载/旧 guest 失效时为 false（防 Invalid
     *  guestInstanceId 刷屏——重建竞态里旧句柄的 executeJavaScript 全是空响） */
    private guestAlive(): boolean {
        try {
            const wv: any = this.webview;
            if (!wv || typeof wv.getWebContentsId !== "function") return false;
            wv.getWebContentsId(); // 未 attach / guest 失效时抛
            return true;
        } catch {
            return false;
        }
    }

    private startHealthMonitor(): void {
        if (this.healthTimer) return;
        this.healthTimer = setInterval(async () => {
            if (this.disposed || this.rebuilding || this.extPageInjecting) return;
            if (!this.guestAlive()) return;
            // 首次加载完成前、以及任何导航进行中都不探测：
            // 加载期间页面主线程繁忙/进程切换会让 executeJavaScript 探测超时，
            // 新页签初始 src 是 about:blank，此时误判重建会让页签永远停在空白页
            if (!this.controller.hasCompletedInitialLoad() || this.controller.isLoading()) {
                // 卡死看门狗：加载中时 did-stop-loading 丢失（如加载中途渲染进程
                // 崩溃且未收到 render-process-gone、或站点 JS 对话框卡死主线程），
                // isLoading() 永远为 true，健康监测被永久跳过 —— 页面停在空白且
                // 永不恢复。超过 90s 仍处于 loading 视为卡死，强制重建恢复。
                if (this.controller.loadingDurationMs() > 90_000 && !this.disposed && !this.rebuilding) {
                    console.warn("[browser-plugin] webview loading stuck >90s, rebuilding");
                    await this.rebuildWebview();
                }
                return;
            }
            try {
                // 垫片页（chrome-extension://，加载被 Electron 拒绝、内容全靠
                // maybeInjectExtensionPage 重建）跳过自动 rebuild：rebuild 恢复
                // 不了"加载被拒"——重建后 loadURL 依旧失败，还得重注入，唯一
                // 效果是把刚渲染好的页面洗成空白（实测 TM options 打开即循环洗白）。
                // 这类页真损坏时的恢复手段是重开页签（或后续做重注入）。
                // 注意不能用 getCurrentUrl 完事：伪装 location 的 hash 写穿透会让
                // guest 真实 URL 变成 about:blank#xxx —— "!== about:blank" 判定失配
                // 后不再兜底 lastKnownUrl，跳过失效 → TM 大体量注入期间 isHealthy
                // 超时×2 → 循环 rebuild（实测设置页打开即"闪一下"+ 陈旧句柄刷屏）。
                // 这里直接看 pendingExtPageUrl：整个扩展页会话期间一律跳过。
                const curUrl = this.controller.getCurrentUrl?.() || "";
                if (/^chrome-extension:\/\//i.test(curUrl) || this.controller.pendingExtPageUrl) return;
                const healthy = await this.controller.isHealthy();
                if (!healthy.ok && !this.disposed && !this.rebuilding) {
                    // 连续两次失败才判定损坏，避免偶发超时误判；失败原因入日志
                    // （detached/error=真搬移，timeout=忙线程误判）——启动期集体
                    // 重建的定性证据（实测 6 页签同秒 broken，需区分根因）。
                    this.healthFailCount++;
                    console.warn(`[browser-plugin] health fail #${this.healthFailCount} (${healthy.reason}) url=${curUrl.slice(0, 60)}`);
                    if (this.healthFailCount >= 2) {
                        this.healthFailCount = 0;
                        console.warn("[browser-plugin] webview broken (moved in DOM?), rebuilding");
                        await this.rebuildWebview();
                    }
                } else {
                    this.healthFailCount = 0;
                }
            } catch {}
        }, 2000);
    }

    /**
     * 重建 webview：新建同属性元素替换旧元素，重新挂载控制器并恢复当前 URL。
     * 用于分屏/页签搬移等 DOM 重新挂载导致 webview guest 损坏的场景。
     */
    private async rebuildWebview(): Promise<void> {
        if (this.disposed || this.rebuilding) return;
        this.rebuilding = true;
        try {
            const savedUrl = this.controller.getCurrentUrl();
            const container = this.element.querySelector(".sy-browser-content");
            if (!container) return;
            const newWebview = this.createWebviewElement();
            if (this.settings.userAgent) {
                newWebview.useragent = this.settings.userAgent;
            }
            this.webview.replaceWith(newWebview);
            this.webview = newWebview;
            this.controller.reattach(newWebview);
            // 重建后的 webview 恢复 UA（商店页需重新伪装 Edge）
            // appliedUserAgent 也要清：新 webview 是新 webContents，旧的已应用值不再适用
            this.edgeUaActive = false;
            this.appliedUserAgent = "";
            if (savedUrl) {
                // 无条件恢复（加载未提交时 getURL 是 about:blank，getCurrentUrl 可能取不到）
                this.syncUserAgent(savedUrl);
                await this.controller.loadURL(savedUrl);
            }
            console.log("[browser-plugin] webview rebuilt, url:", savedUrl);
        } catch (e) {
            console.error("[browser-plugin] rebuildWebview failed:", e);
        } finally {
            this.rebuilding = false;
        }
    }

    private async onToolbarAction(action: string, payload?: any): Promise<void> {
        switch (action) {
            case "back":
                this.controller.goBack();
                break;
            case "forward":
                this.controller.goForward();
                break;
            case "reload":
                this.controller.reload(false);
                break;
            case "forceReload":
                this.controller.reload(true);
                break;
            case "stop":
                this.controller.stop();
                break;
            case "home":
                this.controller.loadURL(this.settings.homepage);
                break;
            case "toggleBookmark":
                await this.toggleBookmark();
                break;
            case "menu":
                this.showMenu(payload?.x, payload?.y);
                break;
            case "findInPage":
                this.controller.findInPage(payload?.text ?? "", payload?.forward ?? true, true);
                break;
            case "openExternal":
                await this.openInDefaultBrowser();
                break;
        }
    }

    private async toggleBookmark(): Promise<void> {
        const url = this.controller.getCurrentUrl();
        if (!url || url === "about:blank") return;
        const title = this.controller.getCurrentTitle() || url;
        await this.deps.bookmarks.toggle({ title, url });
        this.updateBookmarkButton(url);
    }

    /** 在系统默认浏览器中打开当前页面 URL（走插件主实例，绕过链接拦截 patch） */
    private async openInDefaultBrowser(): Promise<void> {
        const url = this.controller.getCurrentUrl();
        if (!url || !/^https?:\/\//i.test(url)) {
            showMessage(this.deps.i18n.openExternal);
            return;
        }
        try {
            const plugin = (window as any).browserPlugin;
            if (plugin?.openInSystemBrowser) {
                plugin.openInSystemBrowser(url);
            } else {
                const electron = (window as any).require?.("electron") || (globalThis as any).require?.("electron");
                const shell = electron?.shell;
                if (shell?.openExternal) {
                    await shell.openExternal(url);
                } else {
                    // 回退：用思源的方式打开
                    window.open(url, "_blank");
                }
            }
        } catch (e) {
            console.warn("[browser-plugin] openInDefaultBrowser failed:", e);
            window.open(url, "_blank");
        }
    }

    private updateBookmarkButton(url: string): void {
        const bookmarked = !!this.deps.bookmarks.find(url);
        this.toolbar.setBookmarked(bookmarked);
    }

    private showMenu(x?: number, y?: number): void {
        try {
            const menu = new Menu("sy-browser-menu");
            if (!menu) {
                console.warn("[browser-plugin] Menu constructor returned null");
                return;
            }
            menu.addItem({
                id: "settings",
                iconHTML: "",
                label: this.deps.i18n.settings,
                click: () => {
                    try {
                        const dlg = new SettingsDialog(this.deps.settings, this.deps.i18n);
                        dlg.extensionOpener = () => {
                            const plugin = (window as any).browserPlugin as any;
                            plugin?.extensionHost?.openManager(this.deps.i18n);
                        };
                        dlg.open();
                    } catch (e) {
                        console.error("[browser-plugin] open settings dialog failed:", e);
                    }
                },
            });
            menu.addItem({
                id: "history",
                iconHTML: "",
                label: this.deps.i18n.history,
                click: () => {
                    document.dispatchEvent(new CustomEvent("sy-browser-open-dock", { detail: { type: "history" } }));
                },
            });
            menu.addItem({
                id: "bookmarks",
                iconHTML: "",
                label: this.deps.i18n.bookmarks,
                click: () => {
                    document.dispatchEvent(new CustomEvent("sy-browser-open-dock", { detail: { type: "bookmarks" } }));
                },
            });
            menu.addItem({
                id: "downloads",
                iconHTML: "",
                label: this.deps.i18n.downloads,
                click: () => {
                    document.dispatchEvent(new CustomEvent("sy-browser-open-dock", { detail: { type: "downloads" } }));
                },
            });
            menu.addSeparator();
            menu.addItem({
                id: "inspect",
                iconHTML: "",
                label: this.deps.i18n.inspect,
                click: () => {
                    try {
                        this.webview.openDevTools?.();
                    } catch {}
                },
            });
            // 优先使用传入的点击坐标，备选按钮位置
            let px = x;
            let py = y;
            if (px == null || py == null) {
                const btn = this.toolbar.element.querySelector('[data-act="menu"]') as HTMLElement;
                const rect = btn.getBoundingClientRect();
                px = rect.right;
                py = rect.bottom;
            }
            console.log("[browser-plugin] showMenu at:", px, py);
            menu.open({ x: px, y: py });
        } catch (e) {
            console.error("[browser-plugin] showMenu failed:", e);
        }
    }

    /** 公共 API（供快捷键调用） */
    reload(): void {
        this.controller.reload(false);
    }
    goBack(): void {
        this.controller.goBack();
    }
    goForward(): void {
        this.controller.goForward();
    }
    focusUrl(): void {
        this.toolbar.focusUrl();
    }
    findInPage(text: string): void {
        this.controller.findInPage(text);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.extPopup) {
            this.extPopup.destroy();
            this.extPopup = null;
        }
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
        if (this.onExtHostLoaded) {
            window.removeEventListener("sy-browser-ext-host-loaded", this.onExtHostLoaded);
            this.onExtHostLoaded = null;
        }
        try {
            (window as any).browserPlugin?.extensionHost?.disposeCsRuntime?.(this.webview);
        } catch {}
        this.controller.dispose();
        this.element.remove();
    }
}
