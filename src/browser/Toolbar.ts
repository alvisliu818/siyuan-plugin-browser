import type { BrowserSettings, IWebviewTag } from "../types";
import { normalizeUrl } from "../utils/url";
import { el, clearChildren, svgIcon } from "../utils/dom";

/** Material Design 图标路径（单色，fill=currentColor 跟随主题） */
const ICON = {
    back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
    forward: "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z",
    reload: "M17.65 6.35A7.958 7.958 0 0012 4a8 8 0 108 8h-2a6 6 0 11-6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
    stop: "M6 6h12v12H6z",
    home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
    bookmark: "M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z",
    bookmarkActive: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
    search: "M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
    openExternal: "M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
    down: "M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z",
    up: "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z",
    close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
} as const;

/** 工具栏按钮动作 */
export type ToolbarAction =
    | "back"
    | "forward"
    | "reload"
    | "forceReload"
    | "stop"
    | "home"
    | "submit"
    | "toggleBookmark"
    | "findInPage"
    | "openExternal";

/** 工具栏回调 */
export interface ToolbarCallbacks {
    onAction(action: ToolbarAction, payload?: any): void;
    onUrlSubmit(url: string): void;
    onFindInPage(text: string): void;
}

/** 工具栏 UI */
export class Toolbar {
    readonly element: HTMLElement;
    private urlbar: HTMLInputElement;
    private backBtn: HTMLButtonElement;
    private forwardBtn: HTMLButtonElement;
    private reloadBtn: HTMLButtonElement;
    private bookmarkBtn: HTMLButtonElement;
    private findbar: HTMLInputElement;
    private findbarWrap: HTMLElement;
    private findbarResult: HTMLElement;
    private loadingBar: HTMLElement;
    private i18n: Record<string, string>;
    private cb: ToolbarCallbacks;
    private settings: BrowserSettings;

    constructor(i18n: Record<string, string>, cb: ToolbarCallbacks, settings: BrowserSettings) {
        this.i18n = i18n;
        this.cb = cb;
        this.settings = settings;
        this.element = this.build();
        this.urlbar = this.element.querySelector(".sy-browser-urlbar")!;
        this.backBtn = this.element.querySelector('[data-act="back"]')!;
        this.forwardBtn = this.element.querySelector('[data-act="forward"]')!;
        this.reloadBtn = this.element.querySelector('[data-act="reload"]')!;
        this.bookmarkBtn = this.element.querySelector('[data-act="bookmark"]')!;
        this.findbarWrap = this.element.querySelector(".sy-browser-findbar-wrap")!;
        this.findbar = this.element.querySelector(".sy-browser-findbar")!;
        this.findbarResult = this.element.querySelector(".sy-browser-findbar-result")!;
        this.loadingBar = this.element.querySelector(".sy-browser-loading-bar")!;
        this.bindEvents();
    }

    private build(): HTMLElement {
        const root = el("div", "sy-browser-toolbar");
        root.innerHTML = `
            <div class="sy-browser-loading-bar"></div>
            <div class="sy-browser-toolbar-row">
                <button class="sy-browser-btn" data-act="back" title="${this.i18n.back}" disabled>${svgIcon(ICON.back)}</button>
                <button class="sy-browser-btn" data-act="forward" title="${this.i18n.forward}" disabled>${svgIcon(ICON.forward)}</button>
                <button class="sy-browser-btn" data-act="reload" title="${this.i18n.reload}">${svgIcon(ICON.reload)}</button>
                <button class="sy-browser-btn" data-act="home" title="${this.i18n.home}">${svgIcon(ICON.home)}</button>
                <input class="sy-browser-urlbar" type="text" placeholder="${this.i18n.addressBar}" spellcheck="false" />
                <button class="sy-browser-btn" data-act="bookmark" title="${this.i18n.addBookmark}">${svgIcon(ICON.bookmark)}</button>
                <button class="sy-browser-btn" data-act="find" title="${this.i18n.findInPage}">${svgIcon(ICON.search)}</button>
                <button class="sy-browser-btn" data-act="openExternal" title="${this.i18n.openExternal}">${svgIcon(ICON.openExternal)}</button>
            </div>
            <div class="sy-browser-findbar-wrap" style="display:none;">
                <input class="sy-browser-findbar" type="text" placeholder="${this.i18n.findInPage}" spellcheck="false" />
                <span class="sy-browser-findbar-result"></span>
                <button class="sy-browser-btn" data-act="findNext">${svgIcon(ICON.down)}</button>
                <button class="sy-browser-btn" data-act="findPrev">${svgIcon(ICON.up)}</button>
                <button class="sy-browser-btn" data-act="findClose">${svgIcon(ICON.close)}</button>
            </div>
        `;
        return root;
    }

    private bindEvents(): void {
        this.element.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            const btn = target.closest("[data-act]") as HTMLElement | null;
            if (!btn) return;
            const act = btn.dataset.act;
            switch (act) {
                case "back":
                    this.cb.onAction("back");
                    break;
                case "forward":
                    this.cb.onAction("forward");
                    break;
                case "reload":
                    if (e.shiftKey) this.cb.onAction("forceReload");
                    else this.cb.onAction("reload");
                    break;
                case "home":
                    this.cb.onAction("home");
                    break;
                case "bookmark":
                    this.cb.onAction("toggleBookmark");
                    break;
                case "find":
                    this.toggleFindbar(true);
                    break;
                case "findNext":
                    this.cb.onAction("findInPage", { forward: true, text: this.findbar.value });
                    break;
                case "findPrev":
                    this.cb.onAction("findInPage", { forward: false, text: this.findbar.value });
                    break;
                case "findClose":
                    this.toggleFindbar(false);
                    break;
                case "stop":
                    this.cb.onAction("stop");
                    break;
                case "openExternal":
                    this.cb.onAction("openExternal");
                    break;
            }
        });

        this.urlbar.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const raw = this.urlbar.value;
                const url = normalizeUrl(raw, this.settings);
                this.cb.onUrlSubmit(url);
            } else if (e.key === "Escape") {
                this.urlbar.blur();
            }
        });

        this.urlbar.addEventListener("focus", () => {
            this.urlbar.select();
        });

        this.findbar.addEventListener("input", () => {
            this.cb.onFindInPage(this.findbar.value);
        });
        this.findbar.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                // Enter 向前查找下一个，Shift+Enter 向后查找上一个
                this.cb.onAction("findInPage", { forward: !e.shiftKey, text: this.findbar.value });
            } else if (e.key === "Escape") {
                this.toggleFindbar(false);
            }
        });
    }

    private toggleFindbar(show: boolean): void {
        this.findbarWrap.style.display = show ? "flex" : "none";
        if (show) {
            this.findbar.focus();
        } else {
            this.findbar.value = "";
            this.findbarResult.textContent = "";
            this.cb.onFindInPage("");
        }
    }

    /** 设置查找匹配结果数显示 */
    setFindResult(activeMatch: number, matches: number): void {
        if (!matches) {
            this.findbarResult.textContent = this.findbar.value ? "0/0" : "";
        } else {
            this.findbarResult.textContent = `${activeMatch}/${matches}`;
        }
    }

    /** 设置地址栏内容（不触发回调） */
    setUrl(url: string): void {
        if (document.activeElement === this.urlbar) return;
        this.urlbar.value = url;
    }

    /** 更新前进/后退按钮可用状态 */
    setNavState(canBack: boolean, canForward: boolean): void {
        this.backBtn.disabled = !canBack;
        this.forwardBtn.disabled = !canForward;
    }

    /** 设置加载状态 */
    setLoading(loading: boolean): void {
        this.loadingBar.style.opacity = loading ? "1" : "0";
        this.reloadBtn.innerHTML = svgIcon(loading ? ICON.stop : ICON.reload);
        this.reloadBtn.dataset.act = loading ? "stop" : "reload";
    }

    /** 切换收藏按钮高亮状态 */
    setBookmarked(bookmarked: boolean): void {
        this.bookmarkBtn.innerHTML = svgIcon(bookmarked ? ICON.bookmarkActive : ICON.bookmark);
        this.bookmarkBtn.classList.toggle("is-active", bookmarked);
    }

    /** 更新设置（用于地址栏规范化） */
    updateSettings(settings: BrowserSettings): void {
        this.settings = settings;
    }

    /** 聚焦地址栏并全选 */
    focusUrl(): void {
        this.urlbar.focus();
        this.urlbar.select();
    }

    get urlbarElement(): HTMLInputElement {
        return this.urlbar;
    }
}
