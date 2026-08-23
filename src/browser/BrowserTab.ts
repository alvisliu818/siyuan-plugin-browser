import { showMessage } from "siyuan";
import type { BrowserSettings, IWebviewTag } from "../types";
import { Toolbar } from "./Toolbar";
import { WebviewController } from "./WebviewController";
import { el } from "../utils/dom";
import type { HistoryStore } from "../storage/historyStore";
import type { BookmarksStore } from "../storage/bookmarksStore";
import type { SettingsStore } from "../storage/settingsStore";

/** 浏览器页签实例依赖 */
export interface BrowserTabDeps {
    i18n: Record<string, string>;
    settings: SettingsStore;
    history: HistoryStore;
    bookmarks: BookmarksStore;
    openUrlInNewTab: (url: string) => void;
    /** 通知页签标题更新（思源 tab 头部） */
    onTabTitleChange: (title: string) => void;
    /** 通知页签图标更新 */
    onTabIconChange: (icon: string) => void;
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

    constructor(deps: BrowserTabDeps, initialUrl?: string) {
        this.deps = deps;
        this.settings = deps.settings.get();
        this.element = this.buildDom();
        this.webview = this.element.querySelector("webview") as unknown as IWebviewTag;
        this.toolbar = new Toolbar(deps.i18n, {
            onAction: (action, payload) => this.onToolbarAction(action, payload),
            onUrlSubmit: (url) => this.controller.loadURL(url),
            onFindInPage: (text) => this.controller.findInPage(text),
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
                onFindResult: (active, total) => {
                    this.toolbar.setFindResult(active, total);
                },
            },
        });

        // 把工具栏插到 webview 之前
        this.element.insertBefore(this.toolbar.element, this.webview.parentElement);

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

        // 异步初始化：先确保 preload 路径就绪，再加载初始 URL
        // preload 必须在 webview 第一次加载前设置，否则不生效
        this.init(initialUrl);
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
            // 从渲染进程获取 Electron session（思源渲染进程支持 require）
            const electron = (window as any).require?.("electron") || (globalThis as any).require?.("electron");
            if (!electron?.session) {
                console.warn("[browser-plugin] electron.session unavailable, trying webview session");
                // 回退：通过 webview.getWebContents() 获取
                const wv: any = this.webview;
                const contents = wv.getWebContents?.();
                const session = contents?.session;
                if (session?.webRequest) {
                    this.registerWebRequest(session);
                } else {
                    console.warn("[browser-plugin] no session available for webRequest");
                }
                return;
            }
            const session = electron.session.fromPartition("persist:siyuan-browser");
            if (!session?.webRequest) {
                console.warn("[browser-plugin] session.fromPartition returned no webRequest");
                return;
            }
            this.registerWebRequest(session);
        } catch (e) {
            console.warn("[browser-plugin] stripSiteSecurityHeaders failed:", e);
        }
    }

    private registerWebRequest(session: any): void {
        // 1. 响应头：移除站点安全限制（CSP / X-Frame-Options）
        session.webRequest.onHeadersReceived((details: any, cb: (r: any) => void) => {
            const headers: Record<string, string> = {};
            if (details?.responseHeaders) {
                for (const key of Object.keys(details.responseHeaders)) {
                    headers[key.toLowerCase()] = details.responseHeaders[key];
                }
            }
            delete headers["content-security-policy"];
            delete headers["content-security-policy-report-only"];
            delete headers["x-frame-options"];
            const out: Record<string, string[]> = {};
            for (const k in headers) out[k] = [headers[k]];
            cb({ responseHeaders: out });
        });
        // 2. 请求头：为出站请求注入 Referer，绕过 CDN 防盗链
        //    站点 CDN 检测到空 Referer 会返回 403（X-Error-Info: EmptyReferer）
        session.webRequest.onBeforeSendHeaders((details: any, cb: (r: any) => void) => {
            const reqUrl = details.url || "";
            if (!/^https?:\/\//i.test(reqUrl)) {
                cb({ requestHeaders: details.requestHeaders });
                return;
            }
            try {
                const referrer = details.referrer || "";
                // 已有合法 http(s) referer → 不改
                if (referrer && /^https?:\/\//i.test(referrer)) {
                    cb({ requestHeaders: details.requestHeaders });
                    return;
                }
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
                const headers = { ...details.requestHeaders };
                headers["Referer"] = refUrl;
                cb({ requestHeaders: headers });
            } catch {
                cb({ requestHeaders: details.requestHeaders });
            }
        });
        console.log("[browser-plugin] webRequest registered (CSP strip + referer inject)");
    }

    private async init(initialUrl?: string): Promise<void> {
        console.log("[browser-plugin] BrowserTab.init, initialUrl:", initialUrl);
        const start = initialUrl || this.settings.homepage;
        if (start && start !== "about:blank") {
            // 先加载 URL（不等 preload，preload 只影响后续页内链接拦截）
            console.log("[browser-plugin] loading URL:", start);
            this.controller.loadURL(start);
        } else {
            console.log("[browser-plugin] skipping load (start is empty or about:blank)");
        }
        // 异步设置 preload（不阻塞首次加载；对后续导航生效）
        this.applyPreload();
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
        // 在构建 webview 时立即设置 preload（若路径已缓存），确保首次加载就生效
        // webpreferences: 允许 preload 中 require('electron')（contextIsolation 关闭）
        //   允许 sub-frame nodeIntegration（preload 注入子框架）
        //   允许加载本地文件（webSecurity 不关闭，避免破坏站点 CSS/CSP）
        let preloadAttr = "";
        try {
            const plugin = (window as any).browserPlugin as any;
            const cached = plugin?.getPreloadPathSync?.();
            if (cached && this.settings.enablePreload) {
                preloadAttr = ` preload="${cached}"`;
            }
        } catch {}
        root.innerHTML = `
            <div class="sy-browser-content">
                <webview src="about:blank" allowpopups="" partition="persist:siyuan-browser" webpreferences="contextIsolation=no,nodeIntegrationInSubFrames=yes"${preloadAttr} style="flex:1;width:100%;border:0;"></webview>
            </div>
        `;
        return root;
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

    /** 在系统默认浏览器中打开当前页面 URL */
    private async openInDefaultBrowser(): Promise<void> {
        const url = this.controller.getCurrentUrl();
        if (!url || !/^https?:\/\//i.test(url)) {
            showMessage(this.deps.i18n.openExternal);
            return;
        }
        try {
            const electron = (window as any).require?.("electron") || (globalThis as any).require?.("electron");
            const shell = electron?.shell;
            if (shell?.openExternal) {
                await shell.openExternal(url);
            } else {
                // 回退：用思源的方式打开
                window.open(url, "_blank");
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
        this.controller.dispose();
        this.element.remove();
    }
}
