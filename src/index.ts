import {
    Plugin,
    openTab,
    showMessage,
    getActiveTab,
    fetchSyncPost,
    Setting,
    Menu,
} from "siyuan";
import { TAB_TYPE, DOCK_BOOKMARKS, DOCK_HISTORY, DOCK_DOWNLOADS, DEFAULT_SETTINGS, SEARCH_ENGINES } from "./constants";
import { BookmarksStore } from "./storage/bookmarksStore";
import { HistoryStore } from "./storage/historyStore";
import { DownloadsStore } from "./storage/downloadsStore";
import { SettingsStore } from "./storage/settingsStore";
import { BrowserTab } from "./browser/BrowserTab";
import type { IBrowserTabData, IWebviewTag, BrowserSettings, ProxyMode } from "./types";
import { BookmarksDock } from "./docks/BookmarksDock";
import { HistoryDock } from "./docks/HistoryDock";
import { DownloadsDock } from "./docks/DownloadsDock";
import { SettingsDialog } from "./settings/SettingsDialog";
import { registerShortcuts } from "./commands/shortcuts";
import { ExtensionHost } from "./extensions/extensionHost";
import { buildEdgeStoreHelperScript, isEdgeAddonsSiteUrl } from "./extensions/edgeStoreHelper";
import { getFilenameFromUrl, isUrlExcluded } from "./utils/url";
import { uid } from "./utils/dom";
import { buildAdBlockCss } from "./browser/adblock";
import { applyProxyToSession } from "./browser/proxy";
import BUILTIN_ADBLOCK_RULES from "./assets/adblock-rules.txt";
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
    /** Chrome 扩展宿主（content script 注入） */
    extensionHost!: ExtensionHost;
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
    private originalWindowOpen: typeof window.open | null = null;

    async onload(): Promise<void> {
        // 全局引用必须在 onload 最早建立：Dock/页签的 init() 在布局构建期执行，
        // 早于 onLayoutReady；若等到 onLayoutReady 才赋值，Dock init 时拿到 undefined
        // 会抛异常，面板一片空白（直到拖动 dock 图标触发重建才恢复）。
        (window as any).browserPlugin = this;

        // 初始化 stores
        this.bookmarksStore = new BookmarksStore(this);
        this.historyStore = new HistoryStore(this);
        this.downloadsStore = new DownloadsStore(this);
        this.settingsStore = new SettingsStore(this);
        this.extensionHost = new ExtensionHost(this);

        // 设置必须在 onload 内完成加载：顶栏图标与 Dock 的注册与否取决于
        // showExtIcon/showXxxDock 开关，注册发生在 onload；onLayoutReady 才加载的话
        // 注册时拿到的还是默认值，用户关掉的图标会先注册出来（思源会 await onload）。
        await this.settingsStore.load();

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
                        injectExtensions: (webview, url) => {
                            try {
                                // 注意：此箭头函数位于 addTab init() 作用域内，this 是页签对象，
                                // 必须用 plugin 引用（window.browserPlugin）而非 this
                                plugin.injectAdFilter(webview, url);
                            } catch (e) {
                                console.warn("[browser-plugin] ad filter inject failed:", e);
                            }
                            try {
                                plugin.extensionHost?.inject(webview, url);
                            } catch (e) {
                                console.warn("[browser-plugin] inject extensions failed:", e);
                            }
                            try {
                                plugin.injectEdgeStoreHelper(webview, url);
                            } catch (e) {
                                console.warn("[browser-plugin] inject edge store helper failed:", e);
                            }
                            try {
                                plugin.extensionHost?.ensureCsRuntime?.(webview);
                            } catch (e) {
                                console.warn("[browser-plugin] ensure cs-runtime failed:", e);
                            }
                        },
                        installEdgeExtension: (id: string, source: string) => {
                            return plugin.extensionHost.installFromEdgeAddons(id).then((r) => {
                                if (r.ok) {
                                    showMessage(plugin.i18n.extInstalled + ": " + r.ext!.name, 3000, "info");
                                } else {
                                    showMessage(
                                        plugin.i18n.extInstallFailed + ": " + (r.error || source),
                                        6000,
                                        "error"
                                    );
                                }
                                return r;
                            });
                        },
                    },
                    data.url
                );
                // 注意：Custom（Model 基类）没有 id 字段，页签 id 在 this.tab.id 上。
                // 之前用 (this as any).id（undefined）落到 uid() 随机 key，
                // 导致 getActiveBrowserTab() 永远查不到实例、"替换当前页"等行为失效。
                plugin.tabInstances.set((this as any).tab?.id || uid(), tab);
                this.element.appendChild(tab.element);
                // 移除默认的 iconBrowser SVG（即使 icon 未设置，思源也可能生成占位）
                try {
                    const graphic = (this as any).tab?.headElement?.querySelector(".item__graphic");
                    if (graphic) graphic.remove();
                } catch {}
            },
            destroy(): void {
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                if (!plugin) return;
                // 优先按页签 id 精确销毁对应实例
                const key = (this as any).tab?.id;
                if (key && plugin.tabInstances.has(key)) {
                    const v = plugin.tabInstances.get(key)!;
                    v.dispose();
                    plugin.tabInstances.delete(key);
                }
                // 兜底：清理已脱离文档的实例（布局搬移期间的残留）
                for (const [k, v] of plugin.tabInstances) {
                    if (v.element.isConnected === false) {
                        v.dispose();
                        plugin.tabInstances.delete(k);
                    }
                }
            },
        });

        // 注册 Dock：书签 / 历史 / 下载（无条件注册，显隐由 applyIconVisibility 的
        // body class + CSS 控制——v3.8.7 removeDock 对 BottomRight 插件 Dock 有 NPE，
        // 且 add/remove 会导致面板重建；CSS 方案下快捷键与页签菜单仍可打开面板）
        this.registerBookmarksDock();
        this.registerHistoryDock();
        this.registerDownloadsDock();

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
                click: () => this.openUrl(url, { force: true }),
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
                click: () => this.openUrl(url, { force: true }),
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

        // 顶栏按钮（icon 支持 svg tag 字符串）。
        // 必须在 onload 注册而非 onLayoutReady：开启「隐藏顶栏」（融合顶栏）时，
        // 分屏页签栏融入顶栏，思源在布局恢复阶段按当时顶栏宽度计算页签切换图标
        // 的避让边距；若图标在 onLayoutReady 才插入，布局期计算已结束且不再重算，
        // 原生「页签切换」图标会与「Chrome 扩展」图标重叠（每次启动必现）。
        // onload 注册可让布局期计算包含本插件图标（与虚拟文档树的扩展市场图标一致）。
        this.addTopBar({
            icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93C7.05 19.44 4 16.08 4 12c0-.61.08-1.21.21-1.78L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41C17.93 5.78 20 8.65 20 12c0 2.08-.81 3.98-2.1 5.39z"/></svg>',
            title: this.i18n.openBrowser,
            position: "right",
            callback: () => {
                this.openUrl(this.settingsStore.get().homepage);
            },
        });

        // 扩展常驻入口：不依赖浏览器标签是否打开。
        // 点击列出有 popup 的扩展；在浏览器标签上时面板嵌进该标签内（tabs 语义正确），
        // 否则退化为新标签直接打开扩展设置页。
        this.registerExtTopBar();

        // 按设置显隐图标（body class + CSS，详见 applyIconVisibility 注释）
        this.applyIconVisibility();

        // 设置变化时同步图标显隐
        this.settingsStore.onChange(() => {
            this.applyIconVisibility();
        });
    }

    /** 注册顶栏「Chrome 扩展」图标。带稳定 id：思源顶栏条目 key 由 legacy-index 变为
     * plugin:...:ext-manager，原生「顶栏图标」对该图标的排序/显隐设置更稳定 */
    private registerExtTopBar(): void {
        // 带 id 后思源顶栏条目的 key 由 legacy-index 变为 plugin:...:ext-manager，
        // 用户在思源「顶栏图标」里对该图标的原排序/显隐记忆会失效一次（重新排一次即可）
        this.addTopBar({
            id: "ext-manager",
            icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5A2.5 2.5 0 0 0 10.5 1 2.5 2.5 0 0 0 8 3.5V5H4a2 2 0 0 0-2 2v3.8h1.5A2.7 2.7 0 0 1 6.2 13.5 2.7 2.7 0 0 1 3.5 16.2H2V20a2 2 0 0 0 2 2h3.8v-1.5A2.7 2.7 0 0 1 10.5 17.8a2.7 2.7 0 0 1 2.7 2.7V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 2.5-2.5 2.5 2.5 0 0 0-2.5-2.5z"/></svg>',
            title: this.i18n.extManager || "Chrome 扩展",
            position: "right",
            callback: () => {
                this.showExtensionTopMenu();
            },
        });
    }

    private registerBookmarksDock(): void {
        // 图标用 iconStar（浏览器书签的星星样式）：iconBookmark 与思源原生书签面板图标重复
        this.addDock({
            config: {
                position: "LeftBottom",
                size: { width: 240, height: 0 },
                icon: "iconStar",
                title: this.i18n.bookmarks,
                hotkey: "⌥⌘B",
            },
            data: {},
            type: DOCK_BOOKMARKS,
            init() {
                const plugin = (window as any).browserPlugin as BrowserPlugin;
                if (!plugin?.bookmarksStore) return;
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
    }

    private registerHistoryDock(): void {
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
                if (!plugin?.historyStore) return;
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
    }

    private registerDownloadsDock(): void {
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
                if (!plugin?.downloadsStore) return;
                const dock = new DownloadsDock(
                    plugin.downloadsStore,
                    plugin.i18n,
                    (url) => plugin.openUrl(url),
                    (url, name) => plugin.startDownload(url, name),
                    (item) => plugin.openDownloadedFile(item),
                    (item) => plugin.showDownloadedInFolder(item)
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
    }

    /**
     * 按设置开关显隐顶栏「Chrome 扩展」图标与书签/历史/下载 Dock 图标。
     * 由 onload 与 settingsStore.onChange 触发；「打开浏览器」图标不受这些开关控制。
     *
     * 实现为 body class + 注入 CSS 规则，而非 removeTopBar/removeDock：
     * - v3.8.7 实测 removeDock 对 BottomRight 位置的插件 Dock 抛 NPE（Dock.remove 内
     *   querySelector 得 null），且 add/remove 会引发 Dock 面板重建与布局重存；
     * - 思源原生 applyDockEntryVisibility / applyTopBarEntryVisibility 会按其配置
     *   反复切换 fn__none，直接改元素 class 会被覆盖；body class 的 display:none
     *   与其正交，重算后依然生效；
     * - 图标保持注册状态：快捷键、浏览器页签菜单仍可打开对应面板。
     */
    private applyIconVisibility(): void {
        const s = this.settingsStore.get();
        const body = document.body;
        body.classList.toggle("sy-browser-hide-ext-icon", !s.showExtIcon);
        body.classList.toggle("sy-browser-hide-bookmarks-dock", !s.showBookmarksDock);
        body.classList.toggle("sy-browser-hide-history-dock", !s.showHistoryDock);
        body.classList.toggle("sy-browser-hide-downloads-dock", !s.showDownloadsDock);
        if (!document.getElementById("sy-browser-icon-visibility")) {
            const style = document.createElement("style");
            style.id = "sy-browser-icon-visibility";
            style.textContent = [
                `body.sy-browser-hide-ext-icon #toolbar [data-id="ext-manager"] { display: none !important; }`,
                `body.sy-browser-hide-bookmarks-dock .dock__item[data-type="${this.name}${DOCK_BOOKMARKS}"] { display: none !important; }`,
                `body.sy-browser-hide-history-dock .dock__item[data-type="${this.name}${DOCK_HISTORY}"] { display: none !important; }`,
                `body.sy-browser-hide-downloads-dock .dock__item[data-type="${this.name}${DOCK_DOWNLOADS}"] { display: none !important; }`,
            ].join("\n");
            document.head.appendChild(style);
        }
    }

    /** 内置广告过滤：dom-ready 时按当前 URL 命中的规则注入隐藏 CSS（动态插入的广告节点同样生效） */
    injectAdFilter(webview: IWebviewTag, url: string): void {
        const s = this.settingsStore.get();
        if (!s.adBlockEnabled) return;
        const css = buildAdBlockCss(url, s.adBlockRules || "", BUILTIN_ADBLOCK_RULES);
        if (!css) return;
        Promise.resolve((webview as any).insertCSS(css)).catch((e) => {
            console.warn("[browser-plugin] ad filter insertCSS failed:", e);
        });
    }

    /** Edge 加载项商店页内助手：详情页注入悬浮"安装到思源"按钮（幂等，非商店页面不注入） */
    injectEdgeStoreHelper(webview: IWebviewTag, url: string): void {
        if (!isEdgeAddonsSiteUrl(url)) return;
        const script = buildEdgeStoreHelperScript({
            install: this.i18n.extEdgePageInstall || "安装到思源",
            installing: this.i18n.extEdgePageInstalling || "安装中...",
            installed: this.i18n.extEdgePageInstalled || "已安装 ✓",
        });
        Promise.resolve(webview.executeJavaScript(script)).catch((e) => {
            console.warn("[browser-plugin] edge store helper inject failed:", e);
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
            window.open = (url?: string | URL, target?: string, features?: string): Window | null => {
                const urlStr = url == null ? "" : String(url);
                if (urlStr && /^https?:\/\//i.test(urlStr)) {
                    // 排除网站：不拦截，回退到原始 window.open（触发思源系统浏览器打开）
                    if (this.isUrlExcluded(urlStr)) {
                        return this.originalWindowOpen!(urlStr, target, features);
                    }
                    const newTab = target === "_blank" || !this.getActiveBrowserTab();
                    console.log("[browser-plugin] window.open intercept:", urlStr, "newTab:", newTab);
                    if (newTab) this.openUrl(urlStr);
                    else this.openUrlInCurrent(urlStr);
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
                // 排除网站：不拦截，放行让思源默认行为（系统浏览器）处理
                if (this.isUrlExcluded(href)) return;
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

    /**
     * 顶栏扩展菜单：列出有 popup 的扩展 + 管理入口。
     *
     * 点击扩展项时的两种路径（见 openExtensionPopup 的语义说明）：
     * - 有活动的浏览器标签 → 面板嵌进该标签内执行，chrome.tabs 指向该页，语义正确；
     * - 没有 → 退化为新标签直接打开 popup 页（"对当前页操作"类的按钮会失效，
     *   但查看/修改扩展自身设置的 options 页不受影响）。
     */
    private showExtensionTopMenu(): void {
        const menu = new Menu();
        const host = this.extensionHost;
        const actionable = host?.listActionable?.() || [];
        if (actionable.length === 0) {
            menu.addItem({ iconHTML: "", label: this.i18n.extEmpty || "尚未安装扩展", click: () => {} });
        }
        for (const ext of actionable) {
            menu.addItem({
                iconHTML: "",
                label: `${ext.name}${ext.enabled ? "" : "（已停用）"}`,
                click: () => {
                    if (!ext.enabled) return;
                    const tab = this.getActiveBrowserTab();
                    if (tab) {
                        void tab.openExtensionPopup(ext.id);
                    } else if (ext.electronId && ext.popupPath) {
                        this.openUrl(`chrome-extension://${ext.electronId}/${String(ext.popupPath).replace(/^\.\//, "")}`);
                    } else {
                        showMessage("无法打开该扩展面板", 4000, "error");
                    }
                },
            });
        }
        if (actionable.length > 0) menu.addSeparator();
        menu.addItem({
            iconHTML: "",
            label: this.i18n.extManager || "管理扩展...",
            click: () => host?.openManager?.(this.i18n),
        });
        menu.addItem({
            iconHTML: "",
            label: this.i18n.extOpenStore || "打开 Edge 加载项商店",
            click: () => host?.openEdgeStore?.(),
        });
        menu.open({ x: window.innerWidth - 220, y: 42 });
    }

    /** 在当前激活的浏览器标签页中加载 URL（替换当前页）；若无则开新标签页 */
    openUrlInCurrent(url: string, opts?: { force?: boolean }): void {
        if (!opts?.force && this.isUrlExcluded(url)) {
            this.openInSystemBrowser(url);
            return;
        }
        const tab = this.getActiveBrowserTab();
        if (tab) {
            tab.loadURL(url);
        } else {
            this.openUrl(url, opts);
        }
    }

    /** 判断 URL 是否在排除网站列表中（匹配则用系统默认浏览器打开） */
    isUrlExcluded(url: string): boolean {
        if (!url || !/^https?:\/\//i.test(url)) return false;
        return isUrlExcluded(url, this.settingsStore.get().excludedSites);
    }

    /** 在系统默认浏览器中打开 URL */
    openInSystemBrowser(url: string): void {
        try {
            const electron = (window as any).require?.("electron") || (globalThis as any).require?.("electron");
            const shell = electron?.shell;
            if (shell?.openExternal) {
                shell.openExternal(url);
            } else {
                window.open(url, "_blank");
            }
        } catch (e) {
            console.warn("[browser-plugin] openInSystemBrowser failed:", e);
            window.open(url, "_blank");
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

        // 代理模式（跟随思源 / 系统代理 / 自定义）
        setting.addItem({
            title: this.i18n.proxyMode || "代理",
            direction: "row",
            description: this.i18n.proxyModeDesc || "浏览器页签使用的网络代理。「跟随思源代理」使用思源「设置 → 网络」中配置的代理（未配置时直连）；思源侧代理变更后需重新保存本设置生效。",
            createActionElement: () => {
                const sel = document.createElement("select");
                sel.className = "b3-select";
                const modes: Array<[ProxyMode, string]> = [
                    ["siyuan", this.i18n.proxyModeSiyuan || "跟随思源代理"],
                    ["system", this.i18n.proxyModeSystem || "系统代理"],
                    ["custom", this.i18n.proxyModeCustom || "自定义代理"],
                ];
                for (const [value, label] of modes) {
                    const opt = document.createElement("option");
                    opt.value = value;
                    opt.textContent = label;
                    if ((s.proxyMode || "system") === value) opt.selected = true;
                    sel.appendChild(opt);
                }
                refs.proxyMode = sel;
                return sel;
            },
        });

        // 自定义代理地址
        setting.addItem({
            title: this.i18n.proxyCustomUrl || "自定义代理地址",
            direction: "row",
            description: this.i18n.proxyCustomUrlDesc || "仅「自定义代理」模式使用。支持 http://host:port、https://、socks5://，或分号分隔的分流规则（如 http=host:port;https=host:port）。留空回退系统代理。",
            createActionElement: () => makeInput("proxyCustomUrl", s.proxyCustomUrl || "", { placeholder: "http://127.0.0.1:7890 或 socks5://127.0.0.1:7891" }),
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
                        // 已保存的笔记本 ID 失效（被删除/关闭）时显式标注，提示重新选择
                        if (s.excerptNotebook && !notebooks.some((nb) => nb.id === s.excerptNotebook)) {
                            const stale = document.createElement("option");
                            stale.value = s.excerptNotebook;
                            stale.textContent = this.i18n.excerptNotebookStale || "(已失效，请重新选择)";
                            stale.selected = true;
                            sel.appendChild(stale);
                        }
                    } catch (e) {
                        console.warn("[browser-plugin] load notebooks failed:", e);
                    }
                })();
                return sel;
            },
        });

        // 摘录保存路径（hpath，支持 sprig 模板）
        setting.addItem({
            title: this.i18n.excerptParentPath || "摘录保存路径",
            direction: "row",
            description: "整页摘录保存到该路径下，如 /剪藏 或 /collections/web。支持 {{...}} sprig 模板。",
            createActionElement: () => makeInput("excerptParentPath", s.excerptParentPath || "/", { placeholder: "/" }),
        });

        // 摘录标签
        setting.addItem({
            title: this.i18n.excerptTags || "摘录标签",
            direction: "row",
            description: "为摘录文档添加标签，逗号分隔。",
            createActionElement: () => makeInput("excerptTags", s.excerptTags || "", { placeholder: "web, clip" }),
        });

        // 摘录下载资源
        setting.addItem({
            title: this.i18n.excerptAssets || "摘录下载资源",
            direction: "row",
            description: "摘录时把网页图片下载到思源资源库（失败时由内核兜底转换）。",
            createActionElement: () => makeCheckbox("excerptAssets", s.excerptAssets !== false),
        });

        // 摘录前处理选项（与官方扩展 exp 选项一致，默认关闭）
        const expOptions: Array<[keyof BrowserSettings, string]> = [
            ["excerptExpBold", "粗体样式转 <b>"],
            ["excerptExpItalic", "斜体样式转 <i>"],
            ["excerptExpUnderline", "下划线样式转 <u>"],
            ["excerptExpRemoveImgLink", "移除图片外层链接"],
            ["excerptExpSpan", "span 换行转 <br>"],
            ["excerptExpSvgToImg", "内嵌 SVG 转图片"],
        ];
        for (const [key, desc] of expOptions) {
            setting.addItem({
                title: this.i18n.excerptExp || "摘录前处理",
                direction: "row",
                description: desc + "（与官方剪藏扩展高级选项一致，默认关闭）",
                createActionElement: () => makeCheckbox(key, (s as any)[key] === true),
            });
        }

        // Chrome 扩展管理
        setting.addItem({
            title: this.i18n.extManager || "Chrome 扩展",
            direction: "row",
            description: "安装未打包扩展目录或 CRX / ZIP 扩展包，内容脚本会注入到浏览器页签中的网页。",
            createActionElement: () => {
                const btn = document.createElement("button");
                btn.className = "b3-button";
                btn.textContent = this.i18n.extManageOpen || "管理扩展...";
                btn.addEventListener("click", () => {
                    this.extensionHost.openManager(this.i18n);
                });
                return btn;
            },
        });

        // 所有链接用插件打开
        setting.addItem({
            title: this.i18n.interceptAllLinks,
            direction: "row",
            description: "拦截思源内所有 http(s) 链接点击，用浏览器插件打开而非系统浏览器。",
            createActionElement: () => makeCheckbox("interceptAllLinks", s.interceptAllLinks),
        });

        // 排除网站
        setting.addItem({
            title: this.i18n.excludedSites,
            direction: "row",
            description: this.i18n.excludedSitesDesc,
            createActionElement: () => {
                const ta = document.createElement("textarea");
                ta.className = "b3-text-field";
                ta.rows = 4;
                ta.style.width = "100%";
                ta.style.resize = "vertical";
                ta.style.fontFamily = "monospace";
                ta.style.minWidth = "240px";
                ta.value = s.excludedSites;
                ta.placeholder = "weibo.com\ntwitter.com\n# *.google.com";
                refs.excludedSites = ta as unknown as HTMLInputElement;
                return ta;
            },
        });

        // 广告过滤开关
        setting.addItem({
            title: this.i18n.adBlockEnabled || "广告过滤",
            direction: "row",
            description: "元素隐藏（注入 CSS），不做网络拦截。修改后刷新页签生效。",
            createActionElement: () => makeCheckbox("adBlockEnabled", s.adBlockEnabled !== false),
        });

        // 自定义广告规则
        setting.addItem({
            title: this.i18n.adBlockRules || "自定义广告规则",
            direction: "row",
            description: this.i18n.adBlockRulesDesc,
            createActionElement: () => {
                const ta = document.createElement("textarea");
                ta.className = "b3-text-field";
                ta.rows = 5;
                ta.style.width = "100%";
                ta.style.resize = "vertical";
                ta.style.fontFamily = "monospace";
                ta.style.minWidth = "240px";
                ta.value = s.adBlockRules || "";
                ta.placeholder = "tgb.cn###tcAd\nexample.com##.ad-banner\n##iframe[src*=\"pos.baidu.com\"]\nexample.com#@#.keep-me";
                refs.adBlockRules = ta as unknown as HTMLInputElement;
                return ta;
            },
        });

        // 图标显示开关（顶栏 Chrome 扩展 / 书签 / 历史 / 下载）
        setting.addItem({
            title: this.i18n.showExtIcon || "显示顶栏「Chrome 扩展」图标",
            direction: "row",
            createActionElement: () => makeCheckbox("showExtIcon", s.showExtIcon),
        });
        setting.addItem({
            title: this.i18n.showBookmarksDock || "显示「书签」面板图标",
            direction: "row",
            createActionElement: () => makeCheckbox("showBookmarksDock", s.showBookmarksDock),
        });
        setting.addItem({
            title: this.i18n.showHistoryDock || "显示「历史」面板图标",
            direction: "row",
            createActionElement: () => makeCheckbox("showHistoryDock", s.showHistoryDock),
        });
        setting.addItem({
            title: this.i18n.showDownloadsDock || "显示「下载」面板图标",
            direction: "row",
            createActionElement: () => makeCheckbox("showDownloadsDock", s.showDownloadsDock),
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

        // 加载持久化数据（settingsStore 已在 onload 加载，供图标注册判定）
        await Promise.all([
            this.bookmarksStore.load(),
            this.historyStore.load(),
            this.downloadsStore.load(),
            this.extensionHost.load(),
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

        // 应用代理设置到 webview 会话（persist:siyuan-browser 是独立 session，
        // 不会继承思源默认 session 的代理，必须显式 setProxy）
        void applyProxyToSession(s);

        // 监听设置变化
        this.settingsStore.onChange(() => {
            const ns = this.settingsStore.get();
            this.historyStore.setLimit(ns.historyLimit);
            this.historyStore.setEnabled(ns.recordHistory);
            void applyProxyToSession(ns);
        });

        // 注意：顶栏按钮已在 onload 注册，不能移到这里——
        // onLayoutReady 时布局期的融合顶栏避让计算已结束且不再重算，
        // 此刻插入的图标会与原生「页签切换」图标重叠（详见 onload 内注释）。

        // 监听内核 RPC 推送的下载进度
        this.bindDownloadProgress();

        // 融合顶栏（开启「隐藏顶栏」时）避让补算：
        // 思源在布局恢复期按“当时”的顶栏图标构成计算分屏页签栏「页签切换」图标的
        // 避让边距，之后插入的图标不会触发重算（addTopBar 内部的 setTabPosition 因
        // centerLayout 未就绪而提前返回），边距偏小 → 原生「页签切换」图标与插件
        // 图标重叠，且偏差量随启动时序浮动。此处派发思源自己监听的顶栏变更事件，
        // 让其用最终图标构成重算边距（实测 v3.8.7 有效）：500ms 一个 tick 派发，
        // 共 20 次（centerLayout 就绪前派发无效，就绪后分屏头部也可能晚几拍挂载，
        // 故就绪后继续派发兜底；重算是幂等操作，重复派发与非融合顶栏下均无副作用）。
        const nudgeTopBar = (tries = 0) => {
            if (tries >= 20) return;
            window.setTimeout(() => {
                if ((window as any).siyuan?.layout?.centerLayout) {
                    window.dispatchEvent(new Event("siyuan-topbar-change"));
                }
                nudgeTopBar(tries + 1);
            }, 500);
        };
        nudgeTopBar();
    }

    onunload(): void {
        // 恢复图标显隐（移除注入样式与 body class）
        document.body.classList.remove(
            "sy-browser-hide-ext-icon",
            "sy-browser-hide-bookmarks-dock",
            "sy-browser-hide-history-dock",
            "sy-browser-hide-downloads-dock"
        );
        document.getElementById("sy-browser-icon-visibility")?.remove();
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
    openUrl(url: string, opts?: { force?: boolean }): void {
        console.log("[browser-plugin] openUrl called with:", url);
        // 排除网站：交由系统默认浏览器打开（显式 force 时跳过检查）
        if (!opts?.force && this.isUrlExcluded(url)) {
            this.openInSystemBrowser(url);
            return;
        }
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

    /** 打开 Dock（未打开时通过思源内部 dock 实例的 toggleModel 打开） */
    private openDock(type: string): void {
        try {
            const item = document.querySelector(`.dock__item[data-type="${type}"]`) as HTMLElement | null;
            if (!item) return;
            const isOpen = item.classList.contains("dock__item--active") && !!this.dockInstances.get(type);
            if (isOpen) return;
            const layout = (window as any).siyuan?.layout;
            const docks = [layout?.leftDock, layout?.rightDock, layout?.topDock, layout?.bottomDock];
            for (const dock of docks) {
                if (dock && typeof dock.toggleModel === "function" && type in (dock.data || {})) {
                    dock.toggleModel(type, true, false, false, false, false);
                    return;
                }
            }
            // 兜底：模拟点击 dock 图标
            item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        } catch (e) {
            console.warn("[browser-plugin] openDock failed:", e);
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

    /** 在系统文件管理器中定位已下载文件（打开文件位置） */
    showDownloadedInFolder(item: { savePath: string }): void {
        if (!item.savePath) {
            showMessage("File path missing", 2000, "info");
            return;
        }
        try {
            // savePath 两种形态 → 绝对磁盘路径：
            //   assets/<file>          → <工作空间>/data/assets/<file>
            //   downloads/<file>       → <工作空间>/data/storage/petal/siyuan-plugin-browser/downloads/<file>
            const wsDir = String((window as any).siyuan?.config?.system?.workspaceDir || "").replace(/[\\/]+$/, "");
            if (!wsDir) {
                showMessage("Workspace dir missing", 3000, "error");
                return;
            }
            let abs: string;
            if (item.savePath.startsWith("assets/")) {
                abs = wsDir + "/data/" + item.savePath;
            } else if (item.savePath.startsWith("downloads/")) {
                abs = wsDir + "/data/storage/petal/siyuan-plugin-browser/" + item.savePath;
            } else {
                showMessage("Saved to: " + item.savePath, 5000, "info");
                return;
            }
            const remote = (window as any).require("@electron/remote");
            if (!remote?.shell?.showItemInFolder) {
                showMessage("shell.showItemInFolder unavailable", 3000, "error");
                return;
            }
            const ok = remote.shell.showItemInFolder(abs);
            if (!ok) showMessage("File not found: " + abs, 4000, "error");
        } catch (e: any) {
            showMessage("Show in folder failed: " + (e?.message || e), 3000, "error");
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
