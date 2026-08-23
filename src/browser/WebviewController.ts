import type { BrowserSettings, IWebviewTag } from "../types";
import type { HistoryStore } from "../storage/historyStore";
import type { BookmarksStore } from "../storage/bookmarksStore";
import { pickFavicon } from "../utils/favicon";

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
        onFindResult?: (activeMatch: number, matches: number) => void;
    };
    private disposed = false;
    private listeners: Array<{ type: string; fn: (e: any) => void }> = [];
    /** 标记当前是 loadURL 发起的编程导航，will-navigate 应放行 */
    private programmaticNav = false;
    /** 去重：最近一次通过任意机制（ipc/new-window/will-navigate）打开的新标签页 URL + 时间 */
    private lastNewTabUrl = "";
    private lastNewTabTime = 0;

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

    attach(): void {
        this.on("did-start-loading", () => {
            this.callbacks.onLoadingChange(true);
            this.faviconEverSet = false;
        });
        this.on("did-stop-loading", () => {
            this.callbacks.onLoadingChange(false);
            // 兜底：通过 executeJavaScript 注入链接拦截器（即使 preload 失效也能工作）
            this.injectLinkInterceptor();
            // 兜底：若 page-favicon-updated 未触发，尝试用站点 favicon.ico
            this.maybeFallbackFavicon();
        });
        this.on("did-navigate", (e) => {
            this.programmaticNav = false;
            const url = e.url;
            this.callbacks.onUrlChange(url);
            this.maybeRecordHistory(url);
        });
        this.on("did-navigate-in-page", (e) => {
            this.programmaticNav = false;
            const url = e.url;
            this.callbacks.onUrlChange(url);
            this.maybeRecordHistory(url);
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
            if (url) {
                e.preventDefault?.();
                this.openNewTabDedup(url, "new-window");
            }
        });
        this.on("ipc-message", (e) => {
            // 监听 preload 脚本通过 ipcRenderer.sendToHost 发来的消息
            // channel: 'browser-open-new-tab', args: [url]
            if (e.channel === "browser-open-new-tab") {
                const url = e.args?.[0];
                if (url) {
                    this.openNewTabDedup(url, "ipc");
                }
            }
        });
        this.on("will-navigate", (e) => {
            const url = e.url;
            console.log("[browser-plugin] will-navigate:", url, "programmaticNav:", this.programmaticNav, "currentUrl:", this.webview.getURL?.());
            if (!url) return;
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
            // 禁用网页默认右键菜单（原自定义右键菜单已移除，仅 preventDefault 抑制 Chromium 默认菜单）
            e.preventDefault?.();
        });
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
        if (url === "about:blank") {
            this.programmaticNav = true;
            this.webview.src = "about:blank";
            return;
        }
        this.programmaticNav = true;
        if (this.settings.userAgent) {
            await this.webview.loadURL(url, { userAgent: this.settings.userAgent });
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
        return this.webview.getURL?.() ?? this.webview.src;
    }

    getCurrentTitle(): string {
        return this.webview.getTitle?.() ?? "";
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
                try { Object.defineProperty(window, 'open', { configurable: false, writable: false, value: window.open }); } catch(e) {}
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
        // 启动轮询：每 300ms 检查 __pendingNewTab
        if (this.pendingNewTabCheckTimer) return;
        this.pendingNewTabCheckTimer = setInterval(() => {
            if (this.disposed) {
                clearInterval(this.pendingNewTabCheckTimer);
                this.pendingNewTabCheckTimer = null;
                return;
            }
            this.webview.executeJavaScript("window.__pendingNewTab || null").then((url) => {
                if (url) {
                    this.webview.executeJavaScript("window.__pendingNewTab = null").catch(() => {});
                    this.openNewTabDedup(url, "inject-poll");
                }
            }).catch(() => {});
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
