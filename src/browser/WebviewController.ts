import type { BrowserSettings, HistoryEntry, IWebviewTag } from "../types";
import type { HistoryStore } from "../storage/historyStore";
import type { BookmarksStore } from "../storage/bookmarksStore";
import { pickFavicon } from "../utils/favicon";
import { parseEdgeInstallNavigation } from "../extensions/edgeStore";
import { showWebViewContextMenu } from "./contextMenu";
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
    /** 首次加载是否已完成（完成前不做健康监测，新页签初始 src 是 about:blank） */
    private hasLoadedOnce = false;
    /** 扩展内容脚本注入回调（dom-ready 时触发） */
    onDomReady?: (webview: IWebviewTag, url: string) => void;

    isLoading(): boolean {
        return this.loading;
    }

    hasCompletedInitialLoad(): boolean {
        return this.hasLoadedOnce;
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
            this.callbacks.onLoadingChange(true);
            this.faviconEverSet = false;
        });
        this.on("did-stop-loading", () => {
            this.loading = false;
            this.hasLoadedOnce = true;
            this.callbacks.onLoadingChange(false);
            // 兜底：通过 executeJavaScript 注入链接拦截器（即使 preload 失效也能工作）
            this.injectLinkInterceptor();
            // 兜底：若 page-favicon-updated 未触发，尝试用站点 favicon.ico
            this.maybeFallbackFavicon();
        });
        this.on("did-navigate", (e) => {
            this.programmaticNav = false;
            const url = e.url;
            if (url && !url.startsWith("data:")) this.lastKnownUrl = url;
            this.callbacks.onUrlChange(url);
            this.maybeRecordHistory(url);
        });
        this.on("did-navigate-in-page", (e) => {
            this.programmaticNav = false;
            const url = e.url;
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
            }
        });
        this.on("will-navigate", (e) => {
            const url = e.url;
            console.log("[browser-plugin] will-navigate:", url, "programmaticNav:", this.programmaticNav, "currentUrl:", this.webview.getURL?.());
            if (!url) return;
            // Edge 商店"获取"按钮落点（microsoft-edge: 协议 / CRX 直链）→ 安装而非导航
            if (this.tryEdgeInstall(url, "will-navigate", () => e.preventDefault?.())) return;
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
     */
    async isHealthy(timeoutMs = 800): Promise<boolean> {
        try {
            if (!this.webview?.isConnected) return false;
            await Promise.race([
                this.webview.executeJavaScript("1"),
                new Promise((_, reject) => setTimeout(() => reject(new Error("health check timeout")), timeoutMs)),
            ]);
            return true;
        } catch {
            return false;
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
        if (!url || url === "about:blank" || url.startsWith("data:")) return;
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
