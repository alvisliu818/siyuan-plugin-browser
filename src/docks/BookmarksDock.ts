import { Menu, Dialog, confirm } from "siyuan";
import type { BookmarksStore } from "../storage/bookmarksStore";
import type { Bookmark } from "../types";
import { el, clearChildren } from "../utils/dom";
import { getFaviconUrl } from "../utils/favicon";

/** 书签 Dock 面板（标签分组 + 搜索） */
export class BookmarksDock {
    readonly element: HTMLElement;
    private searchInput: HTMLInputElement;
    private list: HTMLElement;
    private store: BookmarksStore;
    private i18n: Record<string, string>;
    private openUrl: (url: string) => void;
    private unsubscribe?: () => void;
    private keyword = "";

    constructor(
        store: BookmarksStore,
        i18n: Record<string, string>,
        openUrl: (url: string) => void
    ) {
        this.store = store;
        this.i18n = i18n;
        this.openUrl = openUrl;
        this.element = this.build();
        this.searchInput = this.element.querySelector(".sy-browser-dock-search")!;
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
        const root = el("div", "sy-browser-dock sy-browser-bookmarks");
        root.innerHTML = `
            <div class="sy-browser-dock-toolbar">
                <input class="sy-browser-dock-search" type="text" placeholder="${this.i18n.searchBookmark || "搜索书签"}" spellcheck="false" />
                <button class="sy-browser-dock-btn" data-act="add" title="${this.i18n.addBookmark}">+</button>
            </div>
            <div class="sy-browser-dock-list"></div>
        `;
        root.querySelector("[data-act=add]")!.addEventListener("click", () => this.onAddBookmark());
        this.searchInput = root.querySelector(".sy-browser-dock-search")!;
        this.searchInput.addEventListener("input", () => {
            this.keyword = this.searchInput.value;
            this.render();
        });
        return root;
    }

    private render(): void {
        clearChildren(this.list);
        const items = this.store.search(this.keyword);
        if (items.length === 0) {
            const empty = el("div", "sy-browser-dock-empty", undefined, this.i18n.noBookmarks);
            this.list.appendChild(empty);
            return;
        }
        // 有搜索关键词时平铺显示，否则按标签分组
        if (this.keyword.trim()) {
            for (const b of items) {
                this.list.appendChild(this.renderItem(b, false));
            }
        } else {
            const groups = this.store.groupByTag();
            for (const [tag, bookmarks] of groups) {
                this.list.appendChild(this.renderGroup(tag, bookmarks));
            }
        }
    }

    private renderGroup(tag: string, bookmarks: Bookmark[]): HTMLElement {
        const group = el("div", "sy-browser-dock-group");
        const header = el("div", "sy-browser-dock-group-header");
        header.innerHTML = `<span class="sy-browser-dock-tag-icon">🏷</span> <span>${escapeHtml(tag)}</span> <span class="sy-browser-dock-tag-count">(${bookmarks.length})</span>`;
        header.addEventListener("click", () => {
            group.classList.toggle("is-collapsed");
        });
        group.appendChild(header);
        const body = el("div", "sy-browser-dock-group-body");
        for (const b of bookmarks) {
            body.appendChild(this.renderItem(b, true));
        }
        group.appendChild(body);
        return group;
    }

    private renderItem(item: Bookmark, showTag: boolean): HTMLElement {
        const node = el("div", "sy-browser-dock-item");
        const favicon = `<img class="sy-browser-dock-ico" src="${item.favicon || getFaviconUrl(item.url)}" onerror="this.style.visibility='hidden'"/>`;
        const tagBadges = (item.tags || [])
            .map((t) => `<span class="sy-browser-dock-tag-badge">${escapeHtml(t)}</span>`)
            .join("");
        node.innerHTML = `
            ${favicon}
            <div class="sy-browser-dock-main">
                <span class="sy-browser-dock-title" title="${escapeHtml(item.title || item.url)}">${escapeHtml(item.title || item.url)}</span>
                ${showTag && tagBadges ? `<div class="sy-browser-dock-tags">${tagBadges}</div>` : ""}
            </div>
        `;
        node.addEventListener("click", () => {
            if (item.url) this.openUrl(item.url);
        });
        node.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.showItemMenu(item, e.clientX, e.clientY);
        });
        return node;
    }

    private showItemMenu(item: Bookmark, x: number, y: number): void {
        const menu = new Menu("sy-browser-bookmark-item");
        if (!menu) return;
        if (item.url) {
            menu.addItem({
                id: "open",
                iconHTML: "",
                label: this.i18n.open,
                click: () => this.openUrl(item.url),
            });
        }
        menu.addItem({
            id: "edit",
            iconHTML: "",
            label: this.i18n.edit,
            click: () => this.onEdit(item),
        });
        menu.addItem({
            id: "addTag",
            iconHTML: "",
            label: this.i18n.addTag || "添加标签",
            click: () => this.onAddTag(item),
        });
        // 移除标签子菜单
        if (item.tags && item.tags.length > 0) {
            for (const t of item.tags) {
                menu.addItem({
                    id: "rmtag-" + t,
                    iconHTML: "",
                    label: (this.i18n.removeTag || "移除标签") + ": " + t,
                    click: () => this.store.removeTag(item.id, t),
                });
            }
        }
        menu.addSeparator();
        menu.addItem({
            id: "delete",
            iconHTML: "",
            label: this.i18n.delete,
            click: () => {
                confirm("⚠", this.i18n.delete + " " + item.title + "?", async () => {
                    await this.store.remove(item.id);
                });
            },
        });
        menu.open({ x, y });
    }

    private async onAddBookmark(): Promise<void> {
        const result = await promptDialog(this.i18n.addBookmark, [
            { key: "title", label: this.i18n.title || "标题", value: "" },
            { key: "url", label: "URL", value: "https://" },
            { key: "tags", label: this.i18n.tagsLabel || "标签", value: "", placeholder: "逗号分隔" },
        ]);
        if (!result || !result.title || !result.url) return;
        const tags = result.tags ? result.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
        await this.store.add({ title: result.title, url: result.url, tags });
    }

    private async onEdit(item: Bookmark): Promise<void> {
        const result = await promptDialog(this.i18n.editBookmark, [
            { key: "title", label: this.i18n.title || "标题", value: item.title },
            { key: "url", label: "URL", value: item.url || "" },
            { key: "tags", label: this.i18n.tagsLabel || "标签", value: (item.tags || []).join(", "), placeholder: "逗号分隔" },
        ]);
        if (!result) return;
        const patch: Partial<Bookmark> = { title: result.title };
        if (result.url) patch.url = result.url;
        patch.tags = result.tags ? result.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
        await this.store.update(item.id, patch);
    }

    private async onAddTag(item: Bookmark): Promise<void> {
        const result = await promptDialog(this.i18n.addTag || "添加标签", [
            { key: "tag", label: this.i18n.tagName || "标签名", value: "" },
        ]);
        if (!result || !result.tag) return;
        await this.store.addTag(item.id, result.tag);
    }
}

/**
 * 基于 siyuan Dialog 的输入对话框，替代 Electron 中被禁用的 window.prompt。
 * 支持多个字段，返回字段值映射；用户取消返回 null。
 */
function promptDialog(
    title: string,
    fields: Array<{ key: string; label: string; value: string; placeholder?: string }>
): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
        const fieldsHtml = fields
            .map(
                (f) => `
            <div class="b3-form__row" style="display:flex;align-items:center;padding:8px 0;gap:12px;">
                <label style="flex:0 0 80px;font-size:13px;">${escapeHtml(f.label)}</label>
                <input class="b3-text-field" data-key="${escapeHtml(f.key)}" value="${escapeAttr(f.value)}" placeholder="${escapeAttr(f.placeholder || "")}" style="flex:1;height:28px;padding:0 8px;"/>
            </div>`
            )
            .join("");
        const dialog = new Dialog({
            title,
            content: `
            <div class="b3-form" style="padding:16px;">
                ${fieldsHtml}
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">
                    <button class="b3-button b3-button--cancel" id="sb-prompt-cancel">取消</button>
                    <button class="b3-button" id="sb-prompt-ok">确定</button>
                </div>
            </div>`,
            width: "460px",
            height: "auto" as any,
        });
        const root = dialog.element;
        const collect = (): Record<string, string> => {
            const out: Record<string, string> = {};
            root.querySelectorAll("input[data-key]").forEach((inp: any) => {
                out[inp.dataset.key] = inp.value;
            });
            return out;
        };
        const ok = () => {
            dialog.destroy();
            resolve(collect());
        };
        const cancel = () => {
            dialog.destroy();
            resolve(null);
        };
        root.querySelector("#sb-prompt-ok")!.addEventListener("click", ok);
        root.querySelector("#sb-prompt-cancel")!.addEventListener("click", cancel);
        root.querySelectorAll("input[data-key]").forEach((inp: any) => {
            inp.addEventListener("keydown", (e: KeyboardEvent) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    ok();
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancel();
                }
            });
        });
        const firstInput = root.querySelector("input[data-key]") as HTMLInputElement | null;
        if (firstInput) {
            firstInput.focus();
            firstInput.select();
        }
    });
}

function escapeAttr(s: string): string {
    return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
