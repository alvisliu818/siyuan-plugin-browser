import { Menu, confirm } from "siyuan";
import type { DownloadsStore } from "../storage/downloadsStore";
import type { DownloadItem } from "../types";
import { el, clearChildren } from "../utils/dom";
import { formatBytes, formatTime, getFilenameFromUrl } from "../utils/url";

/** 下载 Dock 面板 */
export class DownloadsDock {
    readonly element: HTMLElement;
    private list: HTMLElement;
    private store: DownloadsStore;
    private i18n: Record<string, string>;
    private openUrl: (url: string) => void;
    /** 重新下载（触发内核 RPC） */
    private redownload: (url: string, suggestedName?: string) => Promise<void>;
    /** 打开已下载文件所在的思源资源路径 */
    private openFile?: (item: DownloadItem) => void;
    private unsubscribe?: () => void;

    constructor(
        store: DownloadsStore,
        i18n: Record<string, string>,
        openUrl: (url: string) => void,
        redownload: (url: string, suggestedName?: string) => Promise<void>,
        openFile?: (item: DownloadItem) => void
    ) {
        this.store = store;
        this.i18n = i18n;
        this.openUrl = openUrl;
        this.redownload = redownload;
        this.openFile = openFile;
        this.element = this.build();
        this.list = this.element.querySelector(".sy-browser-dock-list")!;
    }

    init(): void {
        this.render();
        this.unsubscribe = this.store.onChange(() => this.render());
    }

    destroy(): void {
        this.unsubscribe?.();
    }

    private build(): HTMLElement {
        const root = el("div", "sy-browser-dock sy-browser-downloads");
        root.innerHTML = `
            <div class="sy-browser-dock-toolbar">
                <button class="sy-browser-dock-btn" data-act="clear">${this.i18n.clearCompletedDownloads}</button>
            </div>
            <div class="sy-browser-dock-list"></div>
        `;
        root.querySelector("[data-act=clear]")!.addEventListener("click", async () => {
            await this.store.clearCompleted();
        });
        return root;
    }

    private render(): void {
        clearChildren(this.list);
        const items = this.store.list();
        if (items.length === 0) {
            const empty = el("div", "sy-browser-dock-empty", undefined, this.i18n.noDownloads);
            this.list.appendChild(empty);
            return;
        }
        for (const it of items) {
            this.list.appendChild(this.renderItem(it));
        }
    }

    private renderItem(item: DownloadItem): HTMLElement {
        const node = el("div", "sy-browser-dock-item sy-browser-download-item");
        const pct = item.total > 0 ? Math.min(100, Math.round((item.received / item.total) * 100)) : 0;
        const sizeStr = item.total > 0 ? `${formatBytes(item.received)} / ${formatBytes(item.total)}` : formatBytes(item.received);
        const stateLabel = this.i18n[
            item.state === "completed"
                ? "downloadComplete"
                : item.state === "interrupted"
                ? "downloadFailed"
                : item.state === "canceled"
                ? "downloadCanceled"
                : "loading"
        ];
        node.innerHTML = `
            <div class="sy-browser-dock-main">
                <div class="sy-browser-dock-title" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
                <div class="sy-browser-dock-sub" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
                <div class="sy-browser-dock-progress" style="display:${item.state === "in_progress" ? "block" : "none"};">
                    <div class="sy-browser-dock-progress-bar" style="width:${pct}%;"></div>
                </div>
                <div class="sy-browser-dock-meta">
                    <span class="sy-browser-dock-size">${sizeStr}</span>
                    <span class="sy-browser-dock-status">${stateLabel}</span>
                    ${item.finishedAt ? `<span class="sy-browser-dock-time">${formatTime(item.finishedAt)}</span>` : ""}
                </div>
            </div>
        `;
        node.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.showItemMenu(item, e.clientX, e.clientY);
        });
        return node;
    }

    private showItemMenu(item: DownloadItem, x: number, y: number): void {
        const menu = new Menu("sy-browser-download-item");
        if (!menu) return;
        if (item.state === "completed" && this.openFile) {
            menu.addItem({
                id: "open",
                iconHTML: "",
                label: this.i18n.open,
                click: () => this.openFile?.(item),
            });
        }
        menu.addItem({
            id: "redownload",
            iconHTML: "",
            label: this.i18n.redownload,
            click: () => this.redownload(item.url, getFilenameFromUrl(item.url)),
        });
        menu.addItem({
            id: "copyLink",
            iconHTML: "",
            label: this.i18n.copyLink,
            click: () => navigator.clipboard.writeText(item.url).catch(() => {}),
        });
        menu.addItem({
            id: "delete",
            iconHTML: "",
            label: this.i18n.delete,
            click: () => this.store.remove(item.id),
        });
        (menu as any).open({ x, y });
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
