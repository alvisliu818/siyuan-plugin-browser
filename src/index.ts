import {
    Plugin,
    openTab,
    showMessage,
    getActiveTab,
    fetchSyncPost,
    Setting,
} from "siyuan";
import { TAB_TYPE, DOCK_BOOKMARKS, DOCK_HISTORY, DOCK_DOWNLOADS, DEFAULT_SETTINGS, SEARCH_ENGINES } from "./constants";
import { BookmarksStore } from "./storage/bookmarksStore";
import { HistoryStore } from "./storage/historyStore";
import { DownloadsStore } from "./storage/downloadsStore";
import { SettingsStore } from "./storage/settingsStore";
import { BrowserTab } from "./browser/BrowserTab";
import type { IBrowserTabData, IWebviewTag, BrowserSettings } from "./types";
import { BookmarksDock } from "./docks/BookmarksDock";
import { HistoryDock } from "./docks/HistoryDock";
import { DownloadsDock } from "./docks/DownloadsDock";
import { SettingsDialog } from "./settings/SettingsDialog";
import { registerShortcuts } from "./commands/shortcuts";
import { getFilenameFromUrl } from "./utils/url";
import { uid } from "./utils/dom";
import "./index.scss";

/**
 * 思源浏览器插件主入口。
 *
 * 核心设计：
 * - 每个浏览器页签 = 一个 SiYuan 自定义页签（type=browser-tab），由思源原生页签系统管理
 * - 页签内嵌入 Electron <webview> 标签加载任意网站
 * - 顶栏按钮一键打开主页
 * - 三个 Dock：书签 / 历史 / 下载
 * - 内核插件通过 RPC 提供下载/抓取/HEAD 能力
 */
export default class BrowserPlugin extends Plugin {
    bookmarksStore!: BookmarksStore;
    historyStore!: HistoryStore;
    downloadsStore!: DownloadsStore;
    settingsStore!: SettingsStore;
    /** 浏览器页签实例表：tabId → BrowserTab */
    private tabInstances: Map<string, BrowserTab> = new Map();
    /** Dock 实例引用（用于动态打开） */
    private dockInstances: Map<string, any> = new Map();
    /** preload.js 的 file:// URL（用于 webview preload 属性） */
    private preloadFileUrl: string = "";
    private preloadPathPromise: Promise<string> | null = null;
    /** 全局链接拦截器引用（用于启用/禁用时添加/移除） */
    private globalLinkHandler: ((e: MouseEvent) => void) | null = null;
    /** 原始 window.open 引用（用于恢复） */
    private originalWindowOpen: ((url?: string, target?: string, features?: string) => Window | null) | null = null;

    onload(): void {
        // 初始化 stores
        this.bookmarksStore = new BookmarksStore(this);
        this.historyStore = new HistoryStore(this);
        this.downloadsStore = new DownloadsStore(this);
        this.settingsStore = new SettingsStore(this);

        // 注册自定义页签类型
        this.addTab({
            type: TAB_TYPE,
            init(): void {
                const data = (this.data || {}) as IBrowserTabData;
                console.log("[browser-plugin] tab init, data:", JSON.stringify(data), "this.id:", (this as any).id);
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                const tab = new BrowserTab(
                    {
                        i18n: plugin.i18n,
                        settings: plugin.settingsStore,
                        history: plugin.historyStore,
                        bookmarks: plugin.bookmarksStore,
                        openUrlInNewTab: (url) => plugin.openUrl(url),
                        startDownload: (url, name) => plugin.startDownload(url, name),
                        onTabTitleChange: (title) => {
                            try {
                                const self: any = this;
                                // 优先使用 Custom.tab，备选 Model.parent
                                if (self.tab?.updateTitle) {
                                    self.tab.updateTitle(title);
                                } else if (self.parent?.updateTitle) {
                                    self.parent.updateTitle(title);
                                }
                            } catch {}
                        },
                        onTabIconChange: (icon) => {
                            try {
                                const tab = (this as any).tab;
                                if (!tab?.headElement) return;
                                // 移除默认的 iconBrowser SVG
                                const graphic = tab.headElement.querySelector(".item__graphic");
                                if (graphic) graphic.remove();
                                if (!icon) return;
                                let iconEl = tab.headElement.querySelector(".item__icon") as HTMLElement | null;
                                if (!iconEl) {
                                    iconEl = document.createElement("span");
                                    iconEl.className = "item__icon";
                                    tab.headElement.insertBefore(iconEl, tab.headElement.firstChild);
                                }
                                iconEl.innerHTML = "";
                                const img = document.createElement("img");
                                img.src = icon;
                                img.style.cssText = "width:16px;height:16px;object-fit:contain;vertical-align:middle;";
                                iconEl.appendChild(img);
                            } catch (e) {
                                console.warn("[browser-plugin] set tab icon failed:", e);
                            }
                        },
                    },
                    data.url
                );
                plugin.tabInstances.set((this as any).id || uid(), tab);
                this.element.appendChild(tab.element);
                // 移除默认的 iconBrowser SVG（即使 icon 未设置，思源也可能生成占位）
                try {
                    const graphic = (this as any).tab?.headElement?.querySelector(".item__graphic");
                    if (graphic) graphic.remove();
                } catch {}
            },
            destroy(): void {
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                for (const [k, v] of plugin.tabInstances) {
                    if (v.element.isConnected === false || v.element === (this as any).element?.firstChild) {
                        v.dispose();
                        plugin.tabInstances.delete(k);
                    }
                }
            },
        });

        // 注册 Dock：书签
        this.addDock({
            config: {
                position: "LeftBottom",
                size: { width: 240, height: 0 },
                icon: "iconBookmark",
                title: this.i18n.bookmarks,
                hotkey: "⌥⌘B",
            },
            data: {},
            type: DOCK_BOOKMARKS,
            init() {
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                const dock = new BookmarksDock(plugin.bookmarksStore, plugin.i18n, (url) => plugin.openUrl(url));
                dock.init();
                plugin.dockInstances.set(DOCK_BOOKMARKS, dock);
                this.element.appendChild(dock.element);
            },
            destroy() {
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                const dock = plugin.dockInstances.get(DOCK_BOOKMARKS);
                if (dock) {
                    dock.destroy();
                    plugin.dockInstances.delete(DOCK_BOOKMARKS);
                }
            },
        });

        // 注册 Dock：历史
        this.addDock({
            config: {
                position: "RightTop",
                size: { width: 300, height: 0 },
                icon: "iconHistory",
                title: this.i18n.history,
                hotkey: "⌥⌘Y",
            },
            data: {},
            type: DOCK_HISTORY,
            init() {
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                const dock = new HistoryDock(plugin.historyStore, plugin.i18n, (url) => plugin.openUrl(url));
                dock.init();
                plugin.dockInstances.set(DOCK_HISTORY, dock);
                this.element.appendChild(dock.element);
            },
            destroy() {
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                const dock = plugin.dockInstances.get(DOCK_HISTORY);
                if (dock) {
                    dock.destroy();
                    plugin.dockInstances.delete(DOCK_HISTORY);
                }
            },
        });

        // 注册 Dock：下载
        this.addDock({
            config: {
                position: "BottomRight",
                size: { width: 0, height: 200 },
                icon: "iconDownload",
                title: this.i18n.downloads,
                hotkey: "⌥⌘J",
            },
            data: {},
            type: DOCK_DOWNLOADS,
            init() {
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                const dock = new DownloadsDock(
                    plugin.downloadsStore,
                    plugin.i18n,
                    (url) => plugin.openUrl(url),
                    (url, name) => plugin.startDownload(url, name),
                    (item) => plugin.openDownloadedFile(item)
                );
                dock.init();
                plugin.dockInstances.set(DOCK_DOWNLOADS, dock);
                this.element.appendChild(dock.element);
            },
            destroy() {
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                const dock = plugin.dockInstances.get(DOCK_DOWNLOADS);
                if (dock) {
                    dock.destroy();
                    plugin.dockInstances.delete(DOCK_DOWNLOADS);
                }
            },
        });

        // 监听 Dock 打开事件（来自工具栏菜单和快捷键）
        document.addEventListener("sy-browser-open-dock", (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.type === "bookmarks") this.openDock(DOCK_BOOKMARKS);
            else if (detail?.type === "history") this.openDock(DOCK_HISTORY);
            else if (detail?.type === "downloads") this.openDock(DOCK_DOWNLOADS);
        });

        // eventBus：在链接右键菜单加入"在浏览器插件中打开"
        this.eventBus.on("open-menu-link", (e: any) => {
            const url = e.detail?.url || e.detail?.linkURL || "";
            if (!url || !/^https?:\/\//.test(url)) return;
            e.detail.menu.addItem({
                id: "open-in-browser-plugin",
                iconHTML: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>',
                label: this.i18n.openInBrowser,
                click: () => this.openUrl(url),
            });
        });

        // eventBus：在 siyuan-url 块菜单加入
        this.eventBus.on("open-siyuan-url-block", (e: any) => {
            const url = e.detail?.url || "";
            if (!url) return;
            e.detail.menu?.addItem?.({
                id: "open-in-browser-plugin",
                iconHTML: "",
                label: this.i18n.openInBrowser,
                click: () => this.openUrl(url),
            });
        });

        // 注册快捷键
        registerShortcuts(this, this.i18n);

        // 构建设置页（显示在思源「设置 → 插件」中）
        this.buildSettingPage();

        // 根据设置初始化全局链接拦截
        this.updateGlobalLinkInterceptor();

        // 监听设置变化，动态启用/禁用全局链接拦截
        this.settingsStore.onChange(() => {
            this.updateGlobalLinkInterceptor();
        });
    }

    /**
     * 全局链接拦截器：当 interceptAllLinks=true 时，
     * 拦截思源内所有 http(s) 链接点击，用浏览器插件打开而非系统浏览器。
     *
     * 点击行为与浏览器一致：
     * - 普通左键：在当前激活的浏览器标签页中替换 URL（不开新标签）
     * - Ctrl/Cmd+左键、中键、target=_blank、window.open(_blank)：开新标签页
     * - 如当前激活页签不是浏览器标签页，则开新标签页
     *
     * 思源中链接的两种形式：
     * 1. protyle 编辑器内的链接：<span data-type="a" data-href="http://...">text</span>
     *    点击时思源 JS 调用 window.open(url) → 触发 Electron setWindowOpenHandler → shell.openExternal
     * 2. HTML <a> 标签：<a href="http://..." target="_blank"> → 触发 setWindowOpenHandler
     */
    private updateGlobalLinkInterceptor(): void {
        const enabled = this.settingsStore.get().interceptAllLinks;
        if (enabled && !this.globalLinkHandler) {
            // 1. Monkey-patch window.open：按 target 参数决定开新标签还是替换当前页
            this.originalWindowOpen = window.open.bind(window);
            window.open = (url?: string, target?: string, features?: string): Window | null => {
                if (url && /^https?:\/\//i.test(url)) {
                    const newTab = target === "_blank" || !this.getActiveBrowserTab();
                    console.log("[browser-plugin] window.open intercept:", url, "newTab:", newTab);
                    if (newTab) this.openUrl(url);
                    else this.openUrlInCurrent(url);
                    return null;
                }
                return this.originalWindowOpen!(url, target, features);
            };

            // 2. DOM click 拦截：按修饰键和 target 判断开新标签还是替换当前页
            this.globalLinkHandler = (e: MouseEvent) => {
                // 中键（button=1）也处理，交给浏览器新标签逻辑
                if (e.button !== 0 && e.button !== 1) return;
                const target = e.target as HTMLElement;
                if (!target || typeof target.closest !== "function") return;
                // 跳过浏览器插件自身的 webview 内点击（webview 内有自己的 preload 拦截）
                const webview = target.closest("webview");
                if (webview) return;

                // 检查 <a> 标签
                let href = "";
                let anchorTarget = "";
                const anchor = target.closest("a") as HTMLAnchorElement | null;
                if (anchor && anchor.href) {
                    href = anchor.href;
                    anchorTarget = anchor.target || "";
                } else {
                    // 检查思源 protyle 的 span 链接
                    const span = target.closest('span[data-type="a"]') as HTMLElement | null;
                    if (span) {
                        href = span.getAttribute("data-href") || "";
                    }
                }

                if (!href || !/^https?:\/\//i.test(href)) return;
                e.preventDefault();
                e.stopImmediatePropagation();

                // 浏览器行为：修饰键/中键/target=_blank → 开新标签；否则替换当前页
                const openNewTab =
                    e.button === 1 ||
                    e.ctrlKey ||
                    e.metaKey ||
                    e.shiftKey ||
                    anchorTarget === "_blank" ||
                    !this.getActiveBrowserTab();

                console.log("[browser-plugin] click intercept:", href, "newTab:", openNewTab);
                if (openNewTab) this.openUrl(href);
                else this.openUrlInCurrent(href);
            };
            document.addEventListener("click", this.globalLinkHandler, true);
            // 中键 auxclick 也拦截（部分浏览器 click 不触发中键）
            document.addEventListener("auxclick", this.globalLinkHandler as any, true);
            console.log("[browser-plugin] global link interceptor enabled (window.open + click)");
        } else if (!enabled && this.globalLinkHandler) {
            // 恢复 window.open
            if (this.originalWindowOpen) {
                window.open = this.originalWindowOpen;
                this.originalWindowOpen = null;
            }
            document.removeEventListener("click", this.globalLinkHandler, true);
            document.removeEventListener("auxclick", this.globalLinkHandler as any, true);
            this.globalLinkHandler = null;
            console.log("[browser-plugin] global link interceptor disabled");
        }
    }

    /**
     * 获取当前激活的浏览器标签页实例。
     * 若当前激活的思源页签不是浏览器页签，返回 null。
     */
    private getActiveBrowserTab(): BrowserTab | null {
        try {
            const active = getActiveTab() as any;
            if (!active) return null;
            // tabInstances 的 key 是页签 id
            const tabId = active.id;
            if (!tabId) return null;
            return this.tabInstances.get(tabId) || null;
        } catch {
            return null;
        }
    }

    /** 在当前激活的浏览器标签页中加载 URL（替换当前页）；若无则开新标签页 */
    openUrlInCurrent(url: string): void {
        const tab = this.getActiveBrowserTab();
        if (tab) {
            tab.loadURL(url);
        } else {
            this.openUrl(url);
        }
    }

    /** 构建设置页（this.setting 会在思源设置对话框中显示） */
    private buildSettingPage(): void {
        const s = this.settingsStore.get();
        // 用闭包收集输入元素引用，便于 confirmCallback 读取
        const refs: Record<string, HTMLInputElement | HTMLSelectElement> = {};

        const setting = new Setting({
            width: "600px",
            confirmCallback: () => {
                const patch: Partial<BrowserSettings> = {};
                for (const key in refs) {
                    const el = refs[key];
                    if (el.type === "checkbox") {
                        (patch as any)[key] = (el as HTMLInputElement).checked;
                    } else if (el.type === "number") {
                        (patch as any)[key] = parseInt((el as HTMLInputElement).value, 10) || 0;
                    } else {
                        (patch as any)[key] = (el as HTMLInputElement | HTMLSelectElement).value.trim();
                    }
                }
                this.settingsStore.save(patch);
                showMessage(this.i18n.save + " ✓", 2000, "info");
            },
        });

        const makeInput = (
            key: keyof BrowserSettings,
            value: string,
            attrs: Record<string, string> = {}
        ): HTMLInputElement => {
            const input = document.createElement("input");
            input.className = "b3-text-field";
            input.value = value;
            for (const k in attrs) input.setAttribute(k, attrs[k]);
            refs[key as string] = input;
            return input;
        };
        const makeCheckbox = (key: keyof BrowserSettings, checked: boolean): HTMLInputElement => {
            const input = document.createElement("input");
            input.type = "checkbox";
            input.className = "b3-switch";
            input.checked = checked;
            refs[key as string] = input;
            return input;
        };

        // 主页
        setting.addItem({
            title: this.i18n.homepage,
            direction: "row",
            createActionElement: () => makeInput("homepage", s.homepage),
        });

        // 搜索引擎
        setting.addItem({
            title: this.i18n.searchEngine,
            direction: "row",
            createActionElement: () => {
                const sel = document.createElement("select");
                sel.className = "b3-select";
                SEARCH_ENGINES.forEach((e) => {
                    const opt = document.createElement("option");
                    opt.value = e.id;
                    opt.textContent = e.name;
                    if (e.id === s.searchEngine) opt.selected = true;
                    sel.appendChild(opt);
                });
                const opt = document.createElement("option");
                opt.value = "custom";
                opt.textContent = this.i18n.custom;
                if (s.searchEngine === "custom") opt.selected = true;
                sel.appendChild(opt);
                refs.searchEngine = sel;
                return sel;
            },
        });

        // 自定义搜索引擎 URL
        setting.addItem({
            title: this.i18n.custom,
            direction: "row",
            createActionElement: () => makeInput("customSearchUrl", s.customSearchUrl, { placeholder: "https://example.com/search?q={q}" }),
        });

        // 历史上限
        setting.addItem({
            title: this.i18n.historyLimit,
            direction: "row",
            createActionElement: () => makeInput("historyLimit", String(s.historyLimit), { type: "number", min: "0", max: "50000" }),
        });

        // 记录历史
        setting.addItem({
            title: this.i18n.recordHistory,
            direction: "row",
            createActionElement: () => makeCheckbox("recordHistory", s.recordHistory),
        });

        // 下载位置
        setting.addItem({
            title: this.i18n.downloadTarget,
            direction: "row",
            createActionElement: () => {
                const sel = document.createElement("select");
                sel.className = "b3-select";
                const opt1 = document.createElement("option");
                opt1.value = "assets";
                opt1.textContent = this.i18n.downloadAssets;
                if (s.downloadTarget === "assets") opt1.selected = true;
                sel.appendChild(opt1);
                const opt2 = document.createElement("option");
                opt2.value = "storage";
                opt2.textContent = this.i18n.downloadStorage;
                if (s.downloadTarget === "storage") opt2.selected = true;
                sel.appendChild(opt2);
                refs.downloadTarget = sel;
                return sel;
            },
        });

        // User-Agent
        setting.addItem({
            title: this.i18n.userAgent,
            direction: "row",
            createActionElement: () => makeInput("userAgent", s.userAgent, { placeholder: "(default)" }),
        });

        // 启用 preload
        setting.addItem({
            title: this.i18n.enablePreload,
            direction: "row",
            description: "拦截链接点击，在思源新标签页打开。如不需要可关闭。",
            createActionElement: () => makeCheckbox("enablePreload", s.enablePreload),
        });

        // 摘录保存笔记本
        setting.addItem({
            title: this.i18n.excerptNotebook,
            direction: "row",
            description: "摘录网页正文时保存到此笔记本。",
            createActionElement: () => {
                const sel = document.createElement("select");
                sel.className = "b3-select";
                const emptyOpt = document.createElement("option");
                emptyOpt.value = "";
                emptyOpt.textContent = "(" + this.i18n.excerptNotebook + ")";
                if (!s.excerptNotebook) emptyOpt.selected = true;
                sel.appendChild(emptyOpt);
                refs.excerptNotebook = sel;
                (async () => {
                    try {
                        const { listNotebooks } = await import("./browser/excerpt");
                        const notebooks = await listNotebooks();
                        for (const nb of notebooks) {
                            const opt = document.createElement("option");
                            opt.value = nb.id;
                            opt.textContent = nb.name;
                            if (nb.id === s.excerptNotebook) opt.selected = true;
                            sel.appendChild(opt);
                        }
                    } catch (e) {
                        console.warn("[browser-plugin] load notebooks failed:", e);
                    }
                })();
                return sel;
            },
        });

        // 所有链接用插件打开
        setting.addItem({
            title: this.i18n.interceptAllLinks,
            direction: "row",
            description: "拦截思源内所有 http(s) 链接点击，用浏览器插件打开而非系统浏览器。",
            createActionElement: () => makeCheckbox("interceptAllLinks", s.interceptAllLinks),
        });

        this.setting = setting;
    }

    /** 思源设置对话框中点击「设置」时触发 */
    openSetting(): void {
        // 重新构建以读取最新设置
        this.buildSettingPage();
        this.setting.open(this.name);
    }

    async onLayoutReady(): Promise<void> {
        // 全局引用，便于页签/Dock 的 init 回调中访问插件实例
        (window as any).browserPlugin = this;

        // 加载持久化数据
        await Promise.all([
            this.bookmarksStore.load(),
            this.historyStore.load(),
            this.downloadsStore.load(),
            this.settingsStore.load(),
        ]);

        // 探测 preload.js 的 file:// 路径（用于 webview 拦截新窗口）
        // 不阻塞 layout，异步设置即可
        this.getPreloadPath();

        // 应用设置到 stores
        const s = this.settingsStore.get();
        this.historyStore.setLimit(s.historyLimit);
        this.historyStore.setEnabled(s.recordHistory);

        // 设置加载完成后，重新应用全局链接拦截
        // （onload 中调用时设置尚未加载，interceptAllLinks 仍为默认值 false）
        this.updateGlobalLinkInterceptor();

        // 监听设置变化
        this.settingsStore.onChange(() => {
            const ns = this.settingsStore.get();
            this.historyStore.setLimit(ns.historyLimit);
            this.historyStore.setEnabled(ns.recordHistory);
        });

        // 顶栏按钮（icon 支持 svg tag 字符串）
        this.addTopBar({
            icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93C7.05 19.44 4 16.08 4 12c0-.61.08-1.21.21-1.78L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41C17.93 5.78 20 8.65 20 12c0 2.08-.81 3.98-2.1 5.39z"/></svg>',
            title: this.i18n.openBrowser,
            position: "right",
            callback: () => {
                this.openUrl(this.settingsStore.get().homepage);
            },
        });

        // 监听内核 RPC 推送的下载进度
        this.bindDownloadProgress();
    }

    onunload(): void {
        // 禁用全局链接拦截，恢复 window.open
        if (this.originalWindowOpen) {
            window.open = this.originalWindowOpen;
            this.originalWindowOpen = null;
        }
        if (this.globalLinkHandler) {
            document.removeEventListener("click", this.globalLinkHandler, true);
            this.globalLinkHandler = null;
        }
        // 销毁所有页签实例
        for (const [, tab] of this.tabInstances) {
            tab.dispose();
        }
        this.tabInstances.clear();
        delete (window as any).browserPlugin;
    }

    /** 打开 URL（在新的浏览器页签中） */
    openUrl(url: string): void {
        console.log("[browser-plugin] openUrl called with:", url);
        openTab({
            app: this.app,
            custom: {
                id: this.name + TAB_TYPE,
                icon: "",
                title: url || this.i18n.tabTitle,
                data: { url } as IBrowserTabData,
            },
            openNewTab: true,
        });
    }

    /**
     * 获取 preload.js 的 file:// 绝对 URL（用于 webview preload 属性）。
     *
     * Electron webview 的 preload 必须是 file:// 路径。
     * 思源插件在两种模式下加载位置不同：
     *   - 开发模式：{workspaceDir}/data/storage/petal/{pluginName}/
     *   - 安装模式：{workspaceDir}/data/plugins/{pluginName}/
     * 通过 fetch 探测 plugin.json 决定使用哪个。
     *
     * 结果会被缓存，同步访问时若已探测完成则直接返回。
     */
    getPreloadPath(): Promise<string> {
        if (this.preloadPathPromise) return this.preloadPathPromise;
        this.preloadPathPromise = this.detectPreloadPath();
        return this.preloadPathPromise;
    }

    /** 同步获取已缓存的 preload 路径（未探测完成时返回空串） */
    getPreloadPathSync(): string {
        return this.preloadFileUrl;
    }

    private async detectPreloadPath(): Promise<string> {
        const workspaceDir = (window as any).siyuan?.config?.system?.workspaceDir;
        if (!workspaceDir) {
            console.warn("[browser-plugin] workspaceDir unavailable, preload disabled");
            return "";
        }
        const pluginName = this.name;
        const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/");
        // 把 Windows 路径转为 file:// URL（C:\... -> file:///C:/...）
        const toFileUrl = (absPath: string) =>
            "file:///" + norm(absPath).replace(/^\//, "");

        const tryFetch = async (url: string): Promise<boolean> => {
            try {
                const resp = await fetch(url, { method: "GET" });
                if (!resp.ok) return false;
                // 验证内容确实是 JSON/JS，避免思源对任意路径返回 index.html
                const text = await resp.text();
                return text.length > 20 && !text.trimStart().startsWith("<!");
            } catch {
                return false;
            }
        };

        // 探测插件加载模式（dev: storage/petal；prod: plugins）
        // 并构造对应的 file:// 基础路径和 HTTP 验证路径
        const isDev = await tryFetch(`/storage/petal/${pluginName}/plugin.json`);
        const isProd = !isDev && (await tryFetch(`/plugins/${pluginName}/plugin.json`));
        if (!isDev && !isProd) {
            console.warn("[browser-plugin] plugin dir not found, preload disabled");
            return "";
        }

        const httpPrefix = isDev
            ? `/storage/petal/${pluginName}`
            : `/plugins/${pluginName}`;
        const fsBaseDir = isDev
            ? `${norm(workspaceDir)}/data/storage/petal/${pluginName}`
            : `${norm(workspaceDir)}/data/plugins/${pluginName}`;

        // 候选路径：根目录 preload.js 优先（webpack CopyPlugin 输出到根目录），
        // .src/preload.js 作为开发模式回退
        const candidates = ["preload.js", ".src/preload.js"];
        for (const rel of candidates) {
            if (await tryFetch(`${httpPrefix}/${rel}`)) {
                const url = `${toFileUrl(fsBaseDir)}/${rel}`;
                this.preloadFileUrl = url;
                console.log("[browser-plugin] preload detected:", url);
                return url;
            }
        }

        // 验证失败：用根目录 preload.js 作为兜底（最常见情况）
        const fallback = `${toFileUrl(fsBaseDir)}/preload.js`;
        this.preloadFileUrl = fallback;
        console.warn("[browser-plugin] preload file not verified via HTTP, using fallback:", fallback);
        return fallback;
    }

    /** 打开 Dock */
    private openDock(type: string): void {
        // 思源未提供直接打开 Dock 的公共 API，通过 dock 配置的 hotkey 或自定义事件触发
        // 这里使用 dock 实例的 element 显示，并通知思源布局
        const dock = this.dockInstances.get(type);
        if (dock) {
            // 触发思源内部 dock 切换：通过点击 dock 的占位按钮（如果有）
            // 兜底：直接显示 element
            const evt = new CustomEvent("sy-browser-toggle-dock", { detail: { type } });
            document.dispatchEvent(evt);
            showMessage(this.i18n.bookmarks + " / " + this.i18n.history + " / " + this.i18n.downloads, 1500, "info");
        }
    }

    /**
     * 启动下载。通过内核 RPC 调用 forwardProxy 抓取二进制。
     */
    async startDownload(url: string, suggestedName?: string): Promise<void> {
        const settings = this.settingsStore.get();
        const filename = suggestedName || getFilenameFromUrl(url);
        // 创建下载项
        const item = await this.downloadsStore.create({ url, filename });

        try {
            // 检查内核插件是否可用
            const kernel = (this as any).kernel;
            if (!kernel?.rpc?.call?.download) {
                // 兜底：用 webview 直接下载（仅前端，无法持久化大文件）
                await this.fallbackDownload(url, filename);
                await this.downloadsStore.setState(item.id, "completed");
                return;
            }

            const result = await kernel.rpc.call.download(url, filename, settings.downloadTarget);
            if (result?.ok) {
                await this.downloadsStore.update(item.id, {
                    savePath: result.data.savePath,
                    received: result.data.size,
                    total: result.data.size,
                });
                await this.downloadsStore.setState(item.id, "completed");
                showMessage(this.i18n.downloadComplete + ": " + filename, 3000, "info");
            } else {
                await this.downloadsStore.setState(item.id, "interrupted", result?.error || "Unknown error");
                showMessage(this.i18n.downloadFailed + ": " + (result?.error || ""), 5000, "error");
            }
        } catch (e: any) {
            await this.downloadsStore.setState(item.id, "interrupted", String(e?.message || e));
            showMessage(this.i18n.downloadFailed + ": " + (e?.message || e), 5000, "error");
        }
    }

    /** 兜底下载：直接通过浏览器 a 标签触发（不存储到思源） */
    private async fallbackDownload(url: string, filename: string): Promise<void> {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    /** 打开已下载文件（在文件管理器/思源资源中显示） */
    private async openDownloadedFile(item: { savePath: string; filename: string }): Promise<void> {
        if (!item.savePath) {
            showMessage("File path missing", 2000, "info");
            return;
        }
        // 思源资源路径，通过 file:// 协议在新页签打开（或调用系统 shell）
        try {
            // 尝试在思源中通过 assets 路径打开
            if (item.savePath.startsWith("assets/")) {
                const a = document.createElement("a");
                a.href = "/" + item.savePath;
                a.target = "_blank";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } else {
                // 插件 storage 文件，无直接 URL，提示路径
                showMessage("Saved to: " + item.savePath, 5000, "info");
            }
        } catch (e: any) {
            showMessage("Open failed: " + (e?.message || e), 3000, "error");
        }
    }

    /** 绑定内核插件推送的下载进度事件 */
    private bindDownloadProgress(): void {
        try {
            const kernel = (this as any).kernel;
            if (!kernel?.rpc?.bind) return;
            kernel.rpc.bind("download-progress", (msg: any) => {
                if (!msg?.id) return;
                this.downloadsStore.update(msg.id, {
                    received: msg.received,
                    total: msg.total,
                });
            });
        } catch (e) {
            // 内核不可用时静默忽略
        }
    }
}
