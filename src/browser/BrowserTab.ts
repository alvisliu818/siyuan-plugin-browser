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
import { showExtensionPopupInPage, closeExtensionPopupInPage, injectExtensionPageRuntime } from "./ext-popup";
import { evalInExtensionWorld } from "../extensions/sw-bridge";
import { beginPopupWorld, evalPopupJs, evalInExtensionWorldBridge, feedTabEventForPopup } from "../extensions/cs-runtime";
import { POPUP_JS_PRELUDE } from "./ext-popup";
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

        // 异步初始化：先确保 preload 路径就绪，再加载初始 URL
        // preload 必须在 webview 第一次加载前设置，否则不生效
        this.init(initialUrl);

        // 地址栏旁的扩展图标区：初始刷一次，扩展宿主数据就绪后再刷
        this.onExtHostLoaded = () => void this.refreshExtensionIcons();
        window.addEventListener("sy-browser-ext-host-loaded", this.onExtHostLoaded);
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

    private webviewSessionFallback(): any | null {
        try {
            const wv: any = this.webview;
            return wv?.getWebContents?.()?.session || null;
        } catch {
            return null;
        }
    }

    private registerWebRequest(session: any): void {
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
        // 预热 SW：面板脚本的首个 storage 调用若撞上 SW 冷启动会挂到超时（Clip 无重试
        // 逻辑 → 面板全白"点不开"）。世界创建+脚本注入本身有 1-2s，唤醒并行完成。
        try {
            const wakeP = (window as any).browserPlugin?.extensionHost?.wakeSw?.(ext.electronId);
            if (wakeP) await Promise.race([wakeP, new Promise((r) => setTimeout(r, 2500))]);
        } catch {}
        // anchor 缺省（如从思源顶栏触发）：面板落在右上角
        const r = anchor
            ? anchor.getBoundingClientRect()
            : ({ right: (window.innerWidth || 1200) - 24, bottom: 48 } as DOMRect);
        // popup JS 在扩展专属世界执行（chrome.* 经桥真实可用；主世界是空壳）。
        // 每个文件执行前伪造 document.currentScript —— webpack/rspack runtime 的
        // publicPath 自动检测依赖它（缺失会 throw "Automatic publicPath is not supported"）
        const extInfo = {
            electronId: ext.electronId,
            path: ext.path,
            name: ext.name,
            version: ext.version,
            defaultLocale: ext.defaultLocale,
            contentScripts: ext.contentScripts,
            // popup 世界寄生在宿主页面里（location.href 是页面 URL），但真 Chrome
            // 的弹出面板 sender 是扩展文档 —— SW 侧按 sender.url 判 extpage 白名单
            //（TM 的 hints/syncInfo/tabWatch 等 allow:{extpage:!0}，不符即静默丢弃
            // → 面板空等不渲染），必须以扩展页 URL 身份发包。
            senderPageUrl: "chrome-extension://" + ext.electronId + "/" + String(ext.popupPath).replace(/^\.\//, ""),
        };
        // TM 的 popup 自己不调 chrome.tabs.query，靠 SW 侧 getSelected 解析当前
        // 页签 —— 宿主主动喂一次 tabevent（喂的是"面板锚定的页签"，即本页）。
        // 必须等喂完再放行面板：loadTree 会在面板 JS 启动后立刻发出，抢跑的话
        // SW 侧活动页签还是空 → 面板无 tab 上下文（no access）。限时防挂。
        // （★ 此块必须位于 extInfo 声明之后 —— 初版放在前面踩了 TDZ，
        //   "Cannot access 's' before initialization" 被 catch 吞成静默失败。）
        try {
            const curUrl = String(this.webview.getURL?.() || "");
            const curTitle = String((this.webview as any).getTitle?.() || document.title || "");
            if (/^https?:\/\//i.test(curUrl)) {
                await Promise.race([
                    feedTabEventForPopup(this.webview, extInfo, curUrl, curTitle),
                    new Promise((r2) => setTimeout(r2, 3000)),
                ]);
            }
        } catch {}
        const out = await showExtensionPopupInPage({
            webview: this.webview,
            extPath: ext.path,
            electronId: ext.electronId,
            popupPath: ext.popupPath,
            anchorRect: { right: r.right, bottom: r.bottom },
            // 引导分支伪装：TM 等扩展的 popup 按 location.pathname 分派（/action →
            // popup 分支），宿主页面路径不对则引导整段跳过、UI 只有壳
            spoofLocationUrl: "chrome-extension://" + ext.electronId + "/" + String(ext.popupPath).replace(/^\.\//, ""),
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
        if (!out.ok) {
            showMessage(`打开「${ext.name}」面板失败: ${out.error}`, 5000, "error");
        }
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
                        spoofLocationUrl: url,
                        // Electron 44 实测 webview 加载 chrome-extension:// 被拒（退
                        // about:blank），页面 DOM/CSS 不会原生存在。不能按当前 URL 判断
                        // —— dom-ready 触发时 getURL() 可能还是目标 URL（随后才被洗成
                        // about:blank，注入全被冲掉）。直接探页面实际 DOM：空页即重建。
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
    private startHealthMonitor(): void {
        if (this.healthTimer) return;
        this.healthTimer = setInterval(async () => {
            if (this.disposed || this.rebuilding || this.extPageInjecting) return;
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
                const curUrl = this.controller.getCurrentUrl?.() || "";
                if (/^chrome-extension:\/\//i.test(curUrl)) return;
                const healthy = await this.controller.isHealthy();
                if (!healthy && !this.disposed && !this.rebuilding) {
                    // 连续两次失败才判定损坏，避免偶发超时误判
                    this.healthFailCount++;
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
