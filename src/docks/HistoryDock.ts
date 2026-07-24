import { Menu, confirm } from "siyuan";
import type { HistoryStore } from "../storage/historyStore";
import { el, clearChildren } from "../utils/dom";
import { getFaviconUrl } from "../utils/favicon";
import { formatTime } from "../utils/url";

/** 历史 Dock 面板 */
export class HistoryDock {
    readonly element: HTMLElement;
    private list: HTMLElement;
    private searchInput: HTMLInputElement;
    private store: HistoryStore;
    private i18n: Record<string, string>;
    private openUrl: (url: string) => void;
    private unsubscribe?: () => void;
    private keyword = "";

    constructor(
        store: HistoryStore,
        i18n: Record<string, string>,
        openUrl: (url: string) => void
    ) {
        this.store = store;
        this.i18n = i18n;
        this.openUrl = openUrl;
        this.element = this.build();
        this.list = this.element.querySelector(".sy-browser-dock-list")!;
        this.searchInput = this.element.querySelector(".sy-browser-dock-search")!;
    }

    init(): void {
        this.render();
        this.unsubscribe = this.store.onChange(() => this.render());
        this.searchInput.addEventListener("input", () => {
            this.keyword = this.searchInput.value;
            this.render();
        });
    }

    destroy(): void {
        this.unsubscribe?.();
    }

    private build(): HTMLElement {
        const root = el("div", "sy-browser-dock sy-browser-history");
        root.innerHTML = `
            <div class="sy-browser-dock-toolbar">
                <input class="sy-browser-dock-search" type="text" placeholder="${this.i18n.searchPlaceholder}" />
                <button class="sy-browser-dock-btn" data-act="clear">${this.i18n.clearHistory}</button>
            </div>
            <div class="sy-browser-dock-list"></div>
        `;
        root.querySelector("[data-act=clear]")!.addEventListener("click", () => {
            confirm("⚠", this.i18n.clearHistory + "?", async () => {
                await this.store.clearAll();
            });
        });
        return root;
    }

    private render(): void {
        clearChildren(this.list);
        const entries = this.keyword
            ? this.store.search(this.keyword)
            : this.store.list();
        if (entries.length === 0) {
            const empty = el("div", "sy-browser-dock-empty", undefined, this.i18n.noHistory);
            this.list.appendChild(empty);
            return;
        }
        const groups = this.keyword
            ? [{ label: "search", entries }]
            : this.store.groupByDate();
        for (const g of groups) {
            if (g.entries.length === 0) continue;
            const header = el("div", "sy-browser-dock-group-header", undefined, this.i18n[g.label] || g.label);
            this.list.appendChild(header);
            for (const e of g.entries) {
                this.list.appendChild(this.renderItem(e));
            }
        }
    }

    private renderItem(entry: { url: string; title: string; favicon?: string; visitTime: number }): HTMLElement {
        const node = el("div", "sy-browser-dock-item");
        node.innerHTML = `
            <img class="sy-browser-dock-ico" src="${entry.favicon || getFaviconUrl(entry.url)}" onerror="this.style.visibility='hidden'"/>
            <div class="sy-browser-dock-main">
                <div class="sy-browser-dock-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title || entry.url)}</div>
                <div class="sy-browser-dock-sub" title="${escapeHtml(entry.url)}">${escapeHtml(entry.url)}</div>
            </div>
            <div class="sy-browser-dock-time">${formatTime(entry.visitTime)}</div>
        `;
        node.addEventListener("click", () => this.openUrl(entry.url));
        node.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const menu = new Menu("sy-browser-history-item");
            if (!menu) return;
            menu.addItem({
                id: "open",
                iconHTML: "",
                label: this.i18n.open,
                click: () => this.openUrl(entry.url),
            });
            menu.addItem({
                id: "delete",
                iconHTML: "",
                label: this.i18n.delete,
                click: () => this.store.remove(entry.url),
            });
            (menu as any).open({ x: e.clientX, y: e.clientY });
        });
        return node;
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
