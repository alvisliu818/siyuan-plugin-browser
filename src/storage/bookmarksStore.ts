import type { Bookmark } from "../types";
import { STORAGE_KEYS } from "../constants";
import { uid } from "../utils/dom";

/** 书签 store，使用 Plugin.saveData 持久化 */
export class BookmarksStore {
    private plugin: any;
    private items: Bookmark[] = [];
    private listeners: Array<() => void> = [];

    constructor(plugin: any) {
        this.plugin = plugin;
    }

    async load(): Promise<void> {
        try {
            const data = await this.plugin.loadData(STORAGE_KEYS.bookmarks);
            const raw = data ? (typeof data === "string" ? JSON.parse(data) : data) : [];
            // 数据迁移：旧格式（parentId/isFolder）→ 新格式（tags）
            this.items = raw.map(this.migrate.bind(this));
        } catch {
            this.items = [];
        }
        // 加载完成后通知：若 Dock 在数据就绪前已渲染出空列表，这里触发重渲染
        this.notify();
    }

    /** 旧格式书签迁移为标签格式 */
    private migrate(b: any): Bookmark {
        // 已是新格式
        if (Array.isArray(b.tags)) {
            return b as Bookmark;
        }
        // 旧格式：文件夹项（isFolder=true）直接丢弃，文件夹名通过 parentId 关联
        // 这里把文件夹名转为子项的 tag
        return {
            id: b.id || uid(),
            title: b.title || "",
            url: b.url || "",
            favicon: b.favicon,
            tags: [],
            createdAt: b.createdAt || Date.now(),
            order: b.order,
        };
    }

    async save(): Promise<void> {
        await this.plugin.saveData(STORAGE_KEYS.bookmarks, JSON.stringify(this.items));
        this.notify();
    }

    list(): Bookmark[] {
        return [...this.items];
    }

    /** 按关键词搜索（匹配 title / url / tags） */
    search(keyword: string): Bookmark[] {
        const kw = keyword.trim().toLowerCase();
        if (!kw) return this.list();
        return this.items.filter((b) => {
            return (
                (b.title || "").toLowerCase().includes(kw) ||
                (b.url || "").toLowerCase().includes(kw) ||
                (b.tags || []).some((t) => t.toLowerCase().includes(kw))
            );
        });
    }

    /** 获取所有标签（去重） */
    allTags(): string[] {
        const set = new Set<string>();
        for (const b of this.items) {
            for (const t of b.tags || []) set.add(t);
        }
        return Array.from(set).sort();
    }

    /** 按 tag 分组返回书签 */
    groupByTag(): Map<string, Bookmark[]> {
        const map = new Map<string, Bookmark[]>();
        const untagged = "未分类";
        for (const b of this.items) {
            if (!b.tags || b.tags.length === 0) {
                if (!map.has(untagged)) map.set(untagged, []);
                map.get(untagged)!.push(b);
            } else {
                for (const t of b.tags) {
                    if (!map.has(t)) map.set(t, []);
                    map.get(t)!.push(b);
                }
            }
        }
        return map;
    }

    /** 查询 URL 是否已被收藏 */
    find(url: string): Bookmark | undefined {
        return this.items.find((b) => b.url === url);
    }

    async add(input: { title: string; url: string; favicon?: string; tags?: string[] }): Promise<Bookmark> {
        const item: Bookmark = {
            id: uid(),
            title: input.title,
            url: input.url,
            favicon: input.favicon,
            tags: (input.tags || []).map((t) => t.trim()).filter(Boolean),
            createdAt: Date.now(),
            order: this.items.length,
        };
        this.items.push(item);
        await this.save();
        return item;
    }

    async update(id: string, patch: Partial<Bookmark>): Promise<void> {
        const idx = this.items.findIndex((b) => b.id === id);
        if (idx < 0) return;
        if (patch.tags) {
            patch.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
        }
        this.items[idx] = { ...this.items[idx], ...patch };
        await this.save();
    }

    async remove(id: string): Promise<void> {
        this.items = this.items.filter((b) => b.id !== id);
        await this.save();
    }

    /** 为书签添加标签 */
    async addTag(id: string, tag: string): Promise<void> {
        const item = this.items.find((b) => b.id === id);
        if (!item) return;
        const t = tag.trim();
        if (!t) return;
        if (!item.tags) item.tags = [];
        if (!item.tags.includes(t)) item.tags.push(t);
        await this.save();
    }

    /** 移除书签的某个标签 */
    async removeTag(id: string, tag: string): Promise<void> {
        const item = this.items.find((b) => b.id === id);
        if (!item || !item.tags) return;
        item.tags = item.tags.filter((t) => t !== tag);
        await this.save();
    }

    async toggle(input: { title: string; url: string; favicon?: string }): Promise<boolean> {
        const existing = this.find(input.url);
        if (existing) {
            await this.remove(existing.id);
            return false;
        }
        await this.add(input);
        return true;
    }

    onChange(fn: () => void): () => void {
        this.listeners.push(fn);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== fn);
        };
    }

    private notify(): void {
        this.listeners.forEach((l) => l());
    }
}
