import type { BrowserSettings, IWebviewTag } from "../types";
import { normalizeUrl } from "../utils/url";
import { el, clearChildren } from "../utils/dom";

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
                <button class="sy-browser-btn" data-act="back" title="${this.i18n.back}" disabled>←</button>
                <button class="sy-browser-btn" data-act="forward" title="${this.i18n.forward}" disabled>→</button>
                <button class="sy-browser-btn" data-act="reload" title="${this.i18n.reload}">⟳</button>
                <button class="sy-browser-btn" data-act="home" title="${this.i18n.home}">⌂</button>
                <input class="sy-browser-urlbar" type="text" placeholder="${this.i18n.addressBar}" spellcheck="false" />
                <button class="sy-browser-btn" data-act="bookmark" title="${this.i18n.addBookmark}">☆</button>
                <button class="sy-browser-btn" data-act="find" title="${this.i18n.findInPage}">🔍</button>
                <button class="sy-browser-btn" data-act="openExternal" title="${this.i18n.openExternal}">↗</button>
            </div>
            <div class="sy-browser-findbar-wrap" style="display:none;">
                <input class="sy-browser-findbar" type="text" placeholder="${this.i18n.findInPage}" spellcheck="false" />
                <span class="sy-browser-findbar-result"></span>
                <button class="sy-browser-btn" data-act="findNext">↓</button>
                <button class="sy-browser-btn" data-act="findPrev">↑</button>
                <button class="sy-browser-btn" data-act="findClose">✕</button>
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
        this.reloadBtn.textContent = loading ? "✕" : "⟳";
        this.reloadBtn.dataset.act = loading ? "stop" : "reload";
    }

    /** 切换收藏按钮高亮状态 */
    setBookmarked(bookmarked: boolean): void {
        this.bookmarkBtn.textContent = bookmarked ? "★" : "☆";
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
