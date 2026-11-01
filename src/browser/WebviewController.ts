import type { BrowserSettings, HistoryEntry, IWebviewTag } from "../types";
import type { HistoryStore } from "../storage/historyStore";
import type { BookmarksStore } from "../storage/bookmarksStore";
import { pickFavicon } from "../utils/favicon";
import { parseEdgeInstallNavigation } from "../extensions/edgeStore";
import { showWebViewContextMenu } from "./contextMenu";
import { persistExtLs } from "./ext-popup";
import type { IContextMenuParams } from "../types";

/**
 * Webview 事件路由与状态同步。
 * 负责：监听 webview 事件、同步地址栏/标题/加载状态、记录历史、处理 new-window、上下文菜单。
 */
export class WebviewController {
    private webview: IWebviewTag;
    private settings: BrowserSettings;
    private history: HistoryStore;
    private bookmarks: BookmarksStore;
    private i18n: Record<string, string>;
    private callbacks: {
        onUrlChange: (url: string) => void;
        onTitleChange: (title: string) => void;
        onLoadingChange: (loading: boolean) => void;
        onFaviconChange: (favicon: string) => void;
        onOpenNewTab: (url: string) => void;
        onSaveAs: (url: string, suggestedName?: string) => void;
        onToggleBookmark: () => void;
        onInspect: () => void;
        onFindResult?: (activeMatch: number, matches: number) => void;
        onExcerpt?: (mode: "article" | "part") => void;
        /** Edge 加载项商店安装（详情页悬浮按钮 / 协议跳转拦截触发），resolve 安装结果供按钮回写 */
        onEdgeInstall?: (id: string, source: string) => Promise<{ ok: boolean; error?: string; ext?: any } | void>;
        /** webview 渲染进程崩溃（render-process-gone）：宿主应重建 webview 并恢复 lastKnownUrl */
        onProcessGone?: (reason: string) => void;
    };
    private disposed = false;
    private listeners: Array<{ type: string; fn: (e: any) => void }> = [];
    /** 标记当前是 loadURL 发起的编程导航，will-navigate 应放行 */
    private programmaticNav = false;
    /** 去重：最近一次通过任意机制（ipc/new-window/will-navigate）打开的新标签页 URL + 时间 */
    private lastNewTabUrl = "";
    private lastNewTabTime = 0;
    /** Edge 商店安装去重（will-navigate/did-fail-load/ipc 可能对同一动作多次触发） */
    private lastEdgeInstallId = "";
    private lastEdgeInstallTime = 0;
    /** 最近一次已知的主框架 URL（webview 损坏后 getURL() 不可靠，重建时用它恢复） */
    private lastKnownUrl = "";
    /** 是否有导航正在进行（健康监测在加载期间跳过，避免误判） */
    private loading = false;
    /** 本次 loading 的开始时间（卡死看门狗用：did-stop-loading 丢失时判定卡死） */
    private loadingSince = 0;
    /** 首次加载是否已完成（完成前不做健康监测，新页签初始 src 是 about:blank） */
    private hasLoadedOnce = false;
    /** 扩展内容脚本注入回调（dom-ready 时触发） */
    onDomReady?: (webview: IWebviewTag, url: string) => void;
    /**
     * 改道待注入的扩展整页 URL。chrome-extension:// 页**不原生加载**（见 loadURL
     * 注释），落 about:blank 后由 dom-ready → maybeInjectExtensionPage 用此 URL
     * 重建。不为 null 时 about:blank 的导航事件按目标 URL 语义上报。
     */
    pendingExtPageUrl: string | null = null;

    isLoading(): boolean {
        return this.loading;
    }

    /**
     * 是否本插件管理的扩展的整页 URL。只有管理的扩展才改道 —— 非管理的
     * （宿主未注册或非原生加载）交给 Electron 原生行为，改道只会让页面空白。
     */
    private isManagedExtPage(url: string): boolean {
        if (!url || !/^chrome-extension:\/\//i.test(url)) return false;
        try {
            const host = (window as any).browserPlugin?.extensionHost;
            const list = host?.list?.() || [];
            // ★ 启动竞态防御：宿主数据未就绪（页签恢复早于 extensionHost.load()
            // 完成，list 为空 / electronId 未回填）时**保守按管理页处理**。
            // 本 webview partition 的扩展全部由本插件装入，不存在第三方
            // chrome-extension:// —— 放行只会撞上 Electron 的非确定性原生加载：
            // 主世界跑扩展脚本、preload 在扩展页不生效（实测），引导失败即弹
            // 原生 confirm 同步阻塞（实测 4 连框假死）。误拦的代价只是垫片
            // 未就绪时短暂空白，可接受。
            if (!host || (typeof host.isLoaded === "function" ? !host.isLoaded() : list.length === 0)) {
                return true;
            }
            const m = url.match(/^chrome-extension:\/\/([^/?#\s]+)/i);
            if (!m) return false;
            return list.some((e: any) => e.electronId === m[1] && e.native);
        } catch {
            return true;
        }
    }

    hasCompletedInitialLoad(): boolean {
        return this.hasLoadedOnce;
    }

    /** 当前 loading 已持续毫秒数（未在加载时返回 0） */
    loadingDurationMs(): number {
        return this.loading && this.loadingSince > 0 ? Date.now() - this.loadingSince : 0;
    }

    constructor(
        webview: IWebviewTag,
        deps: {
            settings: BrowserSettings;
            history: HistoryStore;
            bookmarks: BookmarksStore;
            i18n: Record<string, string>;
            callbacks: WebviewController["callbacks"];
        }
    ) {
        this.webview = webview;
        this.settings = deps.settings;
        this.history = deps.history;
        this.bookmarks = deps.bookmarks;
        this.i18n = deps.i18n;
        this.callbacks = deps.callbacks;
    }

    /**
     * 统一去重：打开新标签页。
     * 多个机制（new-window / ipc-message / will-navigate）可能同时触发，
     * 2 秒内同一 URL 只开一次。
     */
    private openNewTabDedup(url: string, source: string): void {
        const now = Date.now();
        if (
            this.lastNewTabUrl === url &&
            this.lastNewTabTime &&
            now - this.lastNewTabTime < 2000
        ) {
            console.log(`[browser-plugin] openNewTab dedup (${source}), already opened:`, url);
            return;
        }
        this.lastNewTabUrl = url;
        this.lastNewTabTime = now;
        console.log(`[browser-plugin] openNewTab (${source}):`, url);
        this.callbacks.onOpenNewTab(url);
    }

    /**
     * 尝试把导航 URL 识别为 Edge 商店安装动作（microsoft-edge: 协议 / CRX 直链）。
     * 命中则 preventDefault 并触发安装，返回 true 表示已处理。
     */
    private tryEdgeInstall(url: string, source: string, prevent: () => void): boolean {
        const id = parseEdgeInstallNavigation(url);
        if (!id) return false;
        prevent();
        this.triggerEdgeInstall(id, source);
        return true;
    }

    /** 触发 Edge 商店扩展安装（带 2 秒去重），并把结果回写到详情页悬浮按钮 */
    private triggerEdgeInstall(id: string, source: string): void {
        const now = Date.now();
        if (
            this.lastEdgeInstallId === id &&
            this.lastEdgeInstallTime &&
            now - this.lastEdgeInstallTime < 2000
        ) {
            console.log(`[browser-plugin] edge install dedup (${source}):`, id);
            return;
        }
        this.lastEdgeInstallId = id;
        this.lastEdgeInstallTime = now;
        console.log(`[browser-plugin] edge store install (${source}):`, id);
        const setBtnState = (s: string) => {
            this.webview
                .executeJavaScript(`window.__syEdgeStoreSetState && window.__syEdgeStoreSetState(${JSON.stringify(s)})`)
                .catch(() => {});
        };
        setBtnState("installing");
        Promise.resolve(this.callbacks.onEdgeInstall?.(id, source))
            .then((r) => setBtnState(r && r.ok ? "ok" : "idle"))
            .catch(() => setBtnState("idle"));
    }

    attach(): void {
        this.on("did-start-loading", () => {
            this.loading = true;
            this.loadingSince = Date.now();
            this.callbacks.onLoadingChange(true);
            this.faviconEverSet = false;
        });
        this.on("did-stop-loading", () => {
            this.loading = false;
            this.loadingSince = 0;
            this.hasLoadedOnce = true;
            this.callbacks.onLoadingChange(false);
            // 兜底：通过 executeJavaScript 注入链接拦截器（即使 preload 失效也能工作）
            this.injectLinkInterceptor();
            // 兜底：若 page-favicon-updated 未触发，尝试用站点 favicon.ico
            this.maybeFallbackFavicon();
        });
        this.on("render-process-gone", (e) => {
            // 渲染进程崩溃（站点 bug / 内存压力被系统杀掉 / GPU 异常）后 guest 变成
            // 空白页；若此时处于加载中，did-stop-loading 不会再触发，健康监测会因
            // isLoading() 永久跳过 —— 页面永远停在空白。这里立即复位加载状态并
            // 通知宿主重建 webview（BrowserTab 用 lastKnownUrl 恢复）。
            const reason = e?.reason || "unknown";
            const exitCode = e?.exitCode;
            console.warn("[browser-plugin] webview render process gone:", reason, "exitCode:", exitCode);
            this.loading = false;
            this.loadingSince = 0;
            this.callbacks.onLoadingChange(false);
            this.callbacks.onProcessGone?.(reason);
        });
        this.on("did-navigate", (e) => {
            this.programmaticNav = false;
            const url = e.url;
            // 改道落地的 about:blank（含 hash 后缀 —— 伪装 location 的 hash 写穿透
            // 会改真实 URL）：lastKnownUrl 保持目标 URL，地址栏也按目标 URL 语义上报
            //（健康监测 skip 条件与 rebuildWebview 恢复都依赖它）
            if (this.pendingExtPageUrl && /^about:blank/i.test(url)) {
                this.callbacks.onUrlChange(this.pendingExtPageUrl + (url.includes("#") ? url.slice(url.indexOf("#")) : ""));
                return;
            }
            // ★ chrome-extension:// 真实源原生落地（2026-10-31 起 = 扩展整页的
            // 正常路径，不再"漏网回收"改道）：地址栏按扩展页 URL 语义上报，
            // 历史不记（与改道时代 about:blank 落地的语义对齐）。垫片注入由
            // dom-ready → maybeInjectExtensionPage 负责。
            if (/^chrome-extension:\/\//i.test(url)) {
                this.callbacks.onUrlChange(url);
                return;
            }
            if (url && !url.startsWith("data:")) this.lastKnownUrl = url;
            this.callbacks.onUrlChange(url);
            this.maybeRecordHistory(url);
        });
        this.on("did-navigate-in-page", (e) => {
            this.programmaticNav = false;
            const url = e.url;
            if (this.pendingExtPageUrl && /^about:blank/i.test(url)) {
                this.callbacks.onUrlChange(this.pendingExtPageUrl);
                return;
            }
            if (url && !url.startsWith("data:")) this.lastKnownUrl = url;
            this.callbacks.onUrlChange(url);
            this.maybeRecordHistory(url);
        });
        this.on("dom-ready", () => {
            // 每次页面导航完成后触发：Chrome 扩展内容脚本在此注入。
            // chrome-extension:// 页面（整页打开的扩展 popup/options）也要通知 ——
            // 它们需要宿主注入扩展专属世界垫片，此前被 http(s) 过滤掉导致
            // 页面脚本跑在 Electron 原生受限主世界里卡死在 loading。
            try {
                const url = this.webview.getURL?.() || "";
                if (/^(https?:|chrome-extension:)\/\//i.test(url)) {
                    this.onDomReady?.(this.webview, url);
                } else if (/^(about:blank|chrome-error:)/i.test(url) && this.pendingExtPageUrl) {
                    // 原生加载失败落地（about:blank 兜底改道残留 / chrome-error
                    // 错误页）：换成改道目标 URL 通知宿主，由 maybeInjectExtension
                    // Page 走磁盘重建 + 隔离世界重放（chrome-error 文档可注入，
                    // rebuildDom 探测到空 DOM 自动置真）
                    this.onDomReady?.(this.webview, this.pendingExtPageUrl);
                }
            } catch {}
        });
        this.on("page-title-updated", (e) => {
            this.callbacks.onTitleChange(e.title);
        });
        this.on("page-favicon-updated", (e) => {
            const favicons: string[] = e.favicons || [];
            const url = this.webview.getURL();
            const faviconUrl = pickFavicon(url, favicons);
            if (faviconUrl) {
                this.loadFaviconAsDataUrl(faviconUrl).then((dataUrl) => {
                    if (dataUrl) {
                        this.callbacks.onFaviconChange(dataUrl);
                    }
                });
            }
        });
        this.on("new-window", (e) => {
            // 兼容旧版 Electron（<22）：拦截 window.open / target=_blank
            // 新版 Electron 已废弃此事件，改用 preload + ipc-message
            const url = e.url;
            if (!url) return;
            // Edge 商店"获取"按钮落点（microsoft-edge: 协议 / CRX 直链）→ 安装而非开新页签
            if (this.tryEdgeInstall(url, "new-window", () => e.preventDefault?.())) return;
            e.preventDefault?.();
            this.openNewTabDedup(url, "new-window");
        });
        this.on("ipc-message", (e) => {
            // 监听 preload 脚本通过 ipcRenderer.sendToHost 发来的消息
            // channel: 'browser-open-new-tab', args: [url]
            if (e.channel === "browser-open-new-tab") {
                const url = e.args?.[0];
                if (url) {
                    this.openNewTabDedup(url, "ipc");
                }
            } else if (e.channel === "browser-edge-install") {
                // 商店详情页悬浮"安装到思源"按钮（preload 桥转发）
                const id = e.args?.[0];
                if (id) this.triggerEdgeInstall(String(id), "ipc");
            } else if (e.channel === "sy-ext-ls-write") {
                // 扩展页（改道重建在 about:blank 上）localStorage 垫片的快照回灌：
                // 宿主页 localStorage 持久化，下次注入作种子（"连宿主 localStorage"）
                try {
                    const p = e.args?.[0];
                    if (p && p.extId) persistExtLs(String(p.extId), p.data);
                } catch {}
            }
        });
        this.on("will-navigate", (e) => {
            const url = e.url;
            console.log("[browser-plugin] will-navigate:", url, "programmaticNav:", this.programmaticNav, "currentUrl:", this.webview.getURL?.());
            if (!url) return;
            // Edge 商店"获取"按钮落点（microsoft-edge: 协议 / CRX 直链）→ 安装而非导航
            if (this.tryEdgeInstall(url, "will-navigate", () => e.preventDefault?.())) return;
            // 本插件管理的扩展整页：页内导航（location.href / 链接点击）直接放行
            // 原生加载（2026-10-31 起扩展页走真实源，见 loadURL 注释；落地后由
            // dom-ready → maybeInjectExtensionPage 注入垫片世界）。
            // 编程导航（loadURL 发起）直接放行，不拦截
            if (this.programmaticNav) {
                this.callbacks.onUrlChange(url);
                return;
            }
            // 去重：如果 2 秒内已通过 ipc/new-window 开过同一 URL 的新标签页，
            // 说明 preload 已拦截并开新标签，这里阻止 webview 内重复导航
            if (
                this.lastNewTabUrl === url &&
                this.lastNewTabTime &&
                Date.now() - this.lastNewTabTime < 2000
            ) {
                console.log("[browser-plugin] will-navigate dedup, preventDefault:", url);
                e.preventDefault?.();
                return;
            }
            // 其余导航（window.location.href、表单提交、点击普通链接等）
            // 全部放行，让 webview 在当前页导航（浏览器行为）。
            // 新标签页的打开由 preload 的 openInNewTab（ipc-message）负责。
            this.callbacks.onUrlChange(url);
        });
        this.on("did-fail-load", (e) => {
            if (e.isMainFrame && e.errorCode === -301 && e.validatedURL) {
                // ERR_UNKNOWN_URL_SCHEME：外部协议导航失败（Electron 可能不触发 will-navigate）
                // Edge 商店"获取"按钮的 microsoft-edge: 协议跳转兜底
                const id = parseEdgeInstallNavigation(e.validatedURL);
                if (id) {
                    this.triggerEdgeInstall(id, "did-fail-load");
                    return;
                }
            }
            if (e.isMainFrame && e.errorCode !== -3) {
                // -3 是中止（用户主动导航或重定向）
                this.showLoadFailedPage(e.errorDescription || "Load failed", e.validatedURL || "");
            }
        });
        // 页面内查找结果反馈
        // Electron webview found-in-page 事件：数据在 e.result，且需等 finalUpdate=true 才有完整 matches
        this.on("found-in-page", (e) => {
            const r = e.result || e;
            const activeMatch = r.activeMatchOrdinal || 0;
            const matches = r.matches || 0;
            const finalUpdate = r.finalUpdate !== false;
            console.log("[browser-plugin] found-in-page:", activeMatch, "/", matches, "final:", finalUpdate);
            // 只在最终更新时回调，避免中间态闪烁
            if (finalUpdate) {
                this.callbacks.onFindResult?.(activeMatch, matches);
            }
        });
        this.on("context-menu", (e) => {
            const params: IContextMenuParams = {
                x: e.params?.x ?? e.x,
                y: e.params?.y ?? e.y,
                linkURL: e.params?.linkURL ?? "",
                srcURL: e.params?.srcURL ?? "",
                pageURL: e.params?.pageURL ?? this.webview.getURL(),
                selectionText: e.params?.selectionText ?? "",
                mediaType: e.params?.mediaType ?? "none",
                isEditable: e.params?.isEditable ?? false,
            };
            e.preventDefault?.();
            // 右键上下文留存：扩展菜单项（如剪藏"复制到思源"）需要 srcURL
            this.lastCtxSrcUrl = params.srcURL || undefined;
            this.lastCtxPageUrl = params.pageURL || this.webview.getURL();
            showWebViewContextMenu(this.webview, params, this.i18n, {
                openInNewTab: (url) => this.callbacks.onOpenNewTab(url),
                saveAs: (url, name) => this.callbacks.onSaveAs(url, name),
                copyImage: (src) => {
                    // 图片复制用 webview 内 clipboard API
                    this.webview.executeJavaScript(`fetch(${JSON.stringify(src)}).then(r=>r.blob()).then(b=>{const r=new FileReader();r.onload=()=>navigator.clipboard.write([new ClipboardItem({'image/png':b})]);r.readAsArrayBuffer(b);});`).catch(() => {});
                },
                excerpt: (mode) => this.callbacks.onExcerpt?.(mode),
                onExtensionMenuItem: (item) => this.onExtMenuItem?.(item),
            }, this.extMenuProvider ? this.extMenuProvider() : []);
        });
    }

    /** 扩展右键菜单项：BrowserTab 注入（缓存读取）与点击回调 */
    private extMenuProvider?: () => Array<{ id: string; title: string; electronId: string; extPath: string }>;
    private onExtMenuItem?: (item: { id: string; title: string; electronId: string; extPath: string }) => void;

    /** 最近一次右键的图片地址 / 页面地址（扩展剪藏项用） */
    lastCtxSrcUrl?: string;
    lastCtxPageUrl?: string;

    setExtensionMenuSource(
        provider: () => Array<{ id: string; title: string; electronId: string; extPath: string }>,
        onClick: (item: { id: string; title: string; electronId: string; extPath: string }) => void,
    ): void {
        this.extMenuProvider = provider;
        this.onExtMenuItem = onClick;
    }

    /** 更新设置引用（设置变更后调用） */
    updateSettings(settings: BrowserSettings): void {
        this.settings = settings;
        if (settings.userAgent) {
            this.webview.useragent = settings.userAgent;
        }
    }

    /** 加载 URL（编程导航，will-navigate 会放行） */
    async loadURL(url: string): Promise<void> {
        console.log("[browser-plugin] loadURL:", url);
        // ★ chrome-extension:// 整页（本插件管理的扩展）：**真实源原生加载**。
        // （2026-10-31 定案，推翻本函数旧注释的"不原生加载"结论：早前"被拒/
        // 非确定性"是探针请求了不存在的根路径 /popup.html 的假象——manifest
        // 映射的真实路径 pages/*.html 用 src 赋值可确定性原生加载。真源 =
        // 原生 localStorage 持久化 + 原生 location 语义；主世界的受限 chrome.*
        // 由 preload confirm 钩子防同步弹框假死，扩展脚本由 maybeInjectExtension
        // Page 的隔离世界重放兜底（原生 DOM 已就位 → rebuildDom 自动判 false）。
        // 必须用 src 属性：webview.loadURL() 对该协议静默失败，见 PopupOverlay。）
        if (this.isManagedExtPage(url)) {
            this.pendingExtPageUrl = url;
            this.lastKnownUrl = url;
            this.callbacks.onUrlChange(url);
            this.programmaticNav = true;
            this.webview.src = url;
            return;
        }
        if (this.pendingExtPageUrl && !/^about:blank$/i.test(url)) {
            // 离开扩展整页：清掉改道状态（否则后续任意 about:blank 都会被误重建）
            this.pendingExtPageUrl = null;
        }
        if (url.startsWith("view-source:")) {
            // view-source 协议：webview 不直接支持，改为抓取后用 srcdoc
            const target = url.slice("view-source:".length);
            try {
                const resp = await fetch(target);
                const text = await resp.text();
                const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                this.programmaticNav = true;
                this.webview.src = "data:text/html;charset=utf-8," + encodeURIComponent(`<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:monospace;">${escaped}</pre>`);
            } catch {
                this.programmaticNav = true;
                this.webview.src = "data:text/html,<pre>Failed to load source</pre>";
            }
            return;
        }
        if (url === "about:blank") {
            this.programmaticNav = true;
            this.webview.src = "about:blank";
            return;
        }
        this.programmaticNav = true;
        if (this.settings.userAgent) {
            try {
                await this.webview.loadURL(url, { userAgent: this.settings.userAgent });
            } catch {
                // webview 尚未 attach（dom-ready 未触发）时 loadURL 会抛异常，回退到 src 赋值。
                // useragent 属性已在 BrowserTab 构造时设置，src 导航同样带 UA。
                this.webview.src = url;
            }
        } else {
            this.webview.src = url;
        }
    }

    goBack(): void {
        if (this.webview.canGoBack?.()) this.webview.goBack();
    }

    goForward(): void {
        if (this.webview.canGoForward?.()) this.webview.goForward();
    }

    reload(force = false): void {
        if (force) this.webview.reloadIgnoringCache?.();
        else this.webview.reload();
    }

    stop(): void {
        this.webview.stop?.();
    }

    findInPage(text: string, forward = true, findNext = false): void {
        if (!text) {
            this.webview.stopFindInPage?.("clearSelection");
            this.callbacks.onFindResult?.(0, 0);
            return;
        }
        // 确保 webview 已 attach 且方法可用
        if (typeof this.webview.findInPage !== "function") {
            console.warn("[browser-plugin] findInPage: webview not attached yet");
            return;
        }
        try {
            // focus webview 以确保查找高亮可见
            this.webview.focus?.();
            this.webview.findInPage(text, { forward, findNext, matchCase: false });
            console.log("[browser-plugin] findInPage called:", text, "forward:", forward, "findNext:", findNext);
        } catch (e) {
            console.warn("[browser-plugin] findInPage failed:", e);
        }
    }

    canGoBack(): boolean {
        return this.webview.canGoBack?.() ?? false;
    }

    canGoForward(): boolean {
        return this.webview.canGoForward?.() ?? false;
    }

    getCurrentUrl(): string {
        try {
            const url = this.webview.getURL?.() || "";
            // 加载未提交时 getURL() 会返回初始的 about:blank，此时优先用已知 URL
            if (url && url !== "about:blank") return url;
            return this.lastKnownUrl || url || this.webview.src || "";
        } catch {
            return this.lastKnownUrl || "";
        }
    }

    getCurrentTitle(): string {
        try {
            return this.webview.getTitle?.() ?? "";
        } catch {
            return "";
        }
    }

    /**
     * 探测 webview 是否仍然健康。
     * 思源分屏/拖动页签会把 panelElement 在 DOM 中搬移，Electron webview 一旦
     * 被重新挂载，内部 guest 即被销毁：页面变白、reload/点击全部无响应。
     * 通过带超时的 executeJavaScript 探测，失败即认为损坏，需要重建。
     * reason 供健康监测区分两类失败：detached/error ≈ 真搬移/真损坏（重建
     * 是唯一恢复手段），timeout ≈ 主线程忙导致的探测超时（重建是误伤，
     * 实测启动恢复期 6 页签同秒误重建）。
     */
    async isHealthy(timeoutMs = 800): Promise<{ ok: boolean; reason: "detached" | "timeout" | "error" | "" }> {
        try {
            if (!this.webview?.isConnected) return { ok: false, reason: "detached" };
            await Promise.race([
                this.webview.executeJavaScript("1"),
                new Promise((_, reject) => setTimeout(() => reject(new Error("health check timeout")), timeoutMs)),
            ]);
            return { ok: true, reason: "" };
        } catch (e) {
            const msg = String((e as Error)?.message || e || "");
            if (!msg.includes("health check timeout")) return { ok: false, reason: "error" };
            // 超时宽限重试一次：主线程忙（启动注入/重页面渲染/重定向搅动）会让
            // 探测排队到秒级，是误重建的主要来源；真损坏（guest 死亡空响）重试
            // 同样超时——多等 2.5s 不影响定性，误伤概率大幅下降。
            try {
                if (!this.webview?.isConnected) return { ok: false, reason: "detached" };
                await Promise.race([
                    this.webview.executeJavaScript("1"),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("health check timeout")), 2500)),
                ]);
                return { ok: true, reason: "" };
            } catch (e2) {
                const msg2 = String((e2 as Error)?.message || e2 || "");
                return { ok: false, reason: msg2.includes("health check timeout") ? "timeout" : "error" };
            }
        }
    }

    /**
     * 重挂载到新的 webview 元素（旧元素已损坏）。
     * 移除旧元素上的全部事件监听，在新元素上重新注册。
     */
    reattach(webview: IWebviewTag): void {
        for (const { type, fn } of this.listeners) {
            try {
                this.webview.removeEventListener(type, fn);
            } catch {}
        }
        this.listeners = [];
        this.webview = webview;
        this.programmaticNav = false;
        this.loading = false;
        this.loadingSince = 0;
        this.lastNewTabUrl = "";
        this.lastNewTabTime = 0;
        this.lastEdgeInstallId = "";
        this.lastEdgeInstallTime = 0;
        this.attach();
    }

    dispose(): void {
        this.disposed = true;
        if (this.pendingNewTabCheckTimer) {
            clearInterval(this.pendingNewTabCheckTimer);
            this.pendingNewTabCheckTimer = null;
        }
        for (const { type, fn } of this.listeners) {
            try {
                this.webview.removeEventListener(type, fn);
            } catch {}
        }
        this.listeners = [];
    }

    private on(type: string, fn: (e: any) => void): void {
        this.webview.addEventListener(type, fn);
        this.listeners.push({ type, fn });
    }

    private async maybeRecordHistory(url: string): Promise<void> {
        // 只记 http(s)：chrome-extension:// 页面（扩展 newtab/popup）、data:、about: 等不入历史
        if (!url || !/^https?:\/\//i.test(url)) return;
        const title = this.webview.getTitle?.() || url;
        const favicon = pickFavicon(url, []);
        await this.history.record({ url, title, favicon });
    }

    /** 标记是否已成功设置过 favicon（避免 did-stop-loading 兜底覆盖已有图标） */
    private faviconEverSet = false;

    /**
     * 在 webview 上下文中 fetch favicon 并转为 data URL。
     * 思源主窗口 CSP 禁止加载外部图片，data URL 不受此限制。
     */
    private async loadFaviconAsDataUrl(url: string): Promise<string> {
        if (!url) return "";
        const script = `(async function(){
            try {
                var resp = await fetch(${JSON.stringify(url)}, {credentials: "omit"});
                if (!resp.ok) return "";
                var blob = await resp.blob();
                return await new Promise(function(resolve){
                    var reader = new FileReader();
                    reader.onload = function(){ resolve(reader.result); };
                    reader.onerror = function(){ resolve(""); };
                    reader.readAsDataURL(blob);
                });
            } catch (e) { return ""; }
        })()`;
        try {
            const result = await this.webview.executeJavaScript(script);
            if (result) {
                this.faviconEverSet = true;
            }
            return result || "";
        } catch {
            return "";
        }
    }

    /** did-stop-loading 兜底：若 page-favicon-updated 未触发，尝试站点 favicon.ico */
    private maybeFallbackFavicon(): void {
        if (this.faviconEverSet) return;
        const url = this.webview.getURL?.() || "";
        if (!/^https?:\/\//i.test(url)) return;
        const faviconUrl = pickFavicon(url, []);
        if (!faviconUrl) return;
        this.loadFaviconAsDataUrl(faviconUrl).then((dataUrl) => {
            if (dataUrl) {
                this.callbacks.onFaviconChange(dataUrl);
            }
        });
    }

    /**
     * 兜底链接拦截器：通过 executeJavaScript 注入。
     * 即使 preload 未加载，也能拦截 link 点击 / window.open / form submit。
     *
     * 行为与浏览器一致：
     * - 普通左键点击：放行，让 webview 在当前页导航
     * - Ctrl/Cmd/Shift+左键、中键、target=_blank、window.open：开新标签页
     *
     * 实现方式：在页面中拦截 click 事件，仅在新标签页意图时阻止默认导航并写入 window.__pendingNewTab。
     * 主进程通过轮询读取该变量并打开新页签。
     */
    private pendingNewTabCheckTimer: any = null;
    private injectLinkInterceptor(): void {
        if (this.disposed) return;
        // guest 失效（重建竞态）时跳过本轮：旧句柄的 invoke 会报
        // Invalid guestInstanceId，刷屏且无意义
        try {
            const wv: any = this.webview;
            if (!wv || typeof wv.getWebContentsId !== "function") return;
            wv.getWebContentsId();
        } catch { return; }
        // 注入拦截脚本（幂等：检查 __browserInterceptorInjected 标记）
        const script = `
            (function(){
                if (window.__browserInterceptorInjected) return;
                window.__browserInterceptorInjected = true;
                window.__pendingNewTab = null;
                var isHttp = function(u){
                    try { return /^https?:\\/\\//i.test(new URL(u, location.href).href); } catch(e) { return false; }
                };
                // link 点击：仅新标签页意图时拦截，普通左键放行让 webview 导航
                // 注意：target=_top/_parent 在无框架 webview 中等同于 _self，不开新标签页
                document.addEventListener('click', function(e){
                    if (e.button !== 0 && e.button !== 1) return;
                    var t = e.target;
                    if (!t || typeof t.closest !== 'function') return;
                    var link = t.closest('a');
                    if (!link || !link.href) return;
                    if (!isHttp(link.href)) return;
                    var openNewTab = e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey ||
                        link.target === '_blank';
                    if (!openNewTab) return; // 普通左键放行
                    e.preventDefault();
                    e.stopPropagation();
                    try { window.__pendingNewTab = new URL(link.href, location.href).href; } catch(err) { window.__pendingNewTab = link.href; }
                    return false;
                }, true);
                // 中键 auxclick
                document.addEventListener('auxclick', function(e){
                    if (e.button !== 1) return;
                    var t = e.target;
                    if (!t || typeof t.closest !== 'function') return;
                    var link = t.closest('a');
                    if (!link || !link.href || !isHttp(link.href)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    try { window.__pendingNewTab = new URL(link.href, location.href).href; } catch(err) { window.__pendingNewTab = link.href; }
                }, true);
                // 拦截 window.open：总是开新标签页
                var origOpen = window.open;
                window.open = function(u, t, f){
                    if (u && isHttp(u)) {
                        try { window.__pendingNewTab = new URL(u, location.href).href; } catch(e) { window.__pendingNewTab = u; }
                    }
                    return null;
                };
                // 不可锁成只读：页面（如 SiYuan 伺服）会在启动时给 window.open 赋值，
                // 锁定会让赋值抛 TypeError 并中断其初始化（卡在 loading 图标）。
                // 拦截 form submit 到 _blank
                document.addEventListener('submit', function(e){
                    var form = e.target;
                    if (!form || form.tagName !== 'FORM') return;
                    if (form.target === '_blank') {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                            var fd = new FormData(form);
                            var params = new URLSearchParams();
                            fd.forEach(function(v,k){ params.append(k, String(v)); });
                            var url = new URL(form.action || location.href);
                            url.search = params.toString();
                            window.__pendingNewTab = url.href;
                        } catch(err) {}
                    }
                }, true);
            })();
        `;
        this.webview.executeJavaScript(script).catch(() => {});
        // 启动轮询：每 300ms 检查 __pendingNewTab / __syEdgeInstall（preload 缺失时的兜底通道）
        if (this.pendingNewTabCheckTimer) return;
        this.pendingNewTabCheckTimer = setInterval(() => {
            if (this.disposed) {
                clearInterval(this.pendingNewTabCheckTimer);
                this.pendingNewTabCheckTimer = null;
                return;
            }
            // guest 失效（重建竞态）守卫：executeJavaScript 在未挂载/旧 guest 上
            // 会**同步**抛出（.catch 挂不上），必须 try 包住整个调用
            try {
                const wv: any = this.webview;
                if (!wv || typeof wv.getWebContentsId !== "function") return;
                wv.getWebContentsId();
            } catch { return; }
            try {
                this.webview
                    .executeJavaScript("({t: window.__pendingNewTab || null, e: window.__syEdgeInstall || null})")
                    .then((r: any) => {
                        if (r && r.t) {
                            this.webview.executeJavaScript("window.__pendingNewTab = null").catch(() => {});
                            this.openNewTabDedup(r.t, "inject-poll");
                        } else if (r && r.e) {
                            this.webview.executeJavaScript("window.__syEdgeInstall = null").catch(() => {});
                            this.triggerEdgeInstall(String(r.e), "inject-poll");
                        }
                    })
                    .catch(() => {});
            } catch {}
        }, 300);
    }

    private showLoadFailedPage(error: string, url: string): void {
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
            body { font-family: sans-serif; padding: 40px; text-align: center; color: #555; }
            h1 { color: #c33; }
            a { color: #1976d2; }
        </style></head><body>
        <h1>${this.i18n.loadFailed}</h1>
        <p>${error}</p>
        <p><a href="${url}">${url}</a></p>
        </body></html>`;
        this.webview.src = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    }
}
