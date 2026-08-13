import type { HistoryEntry } from "../types";
import { STORAGE_KEYS } from "../constants";
import { HISTORY_HARD_LIMIT } from "../constants";

export class HistoryStore {
    private plugin: any;
    private items: HistoryEntry[] = [];
    private limit = 5000;
    private enabled = true;
    private listeners: Array<() => void> = [];

    constructor(plugin: any) {
        this.plugin = plugin;
    }

    async load(): Promise<void> {
        try {
            const data = await this.plugin.loadData(STORAGE_KEYS.history);
            this.items = data ? (typeof data === "string" ? JSON.parse(data) : data) : [];
        } catch {
            this.items = [];
        }
        // 加载完成后通知：若 Dock 在数据就绪前已渲染出空列表，这里触发重渲染
        this.notify();
    }

    async save(): Promise<void> {
        await this.plugin.saveData(STORAGE_KEYS.history, JSON.stringify(this.items));
        this.notify();
    }

    setLimit(limit: number): void {
        this.limit = Math.min(Math.max(0, limit), HISTORY_HARD_LIMIT);
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    list(): HistoryEntry[] {
        return [...this.items];
    }

    /** 记录一次访问。同一 URL 在最近 10 分钟内只记一次，更新 visitTime */
    async record(entry: Omit<HistoryEntry, "visitTime"> & { visitTime?: number }): Promise<void> {
        if (!this.enabled) return;
        const now = entry.visitTime ?? Date.now();
        const recent = this.items.find((h) => h.url === entry.url && now - h.visitTime < 10 * 60 * 1000);
        if (recent) {
            recent.visitTime = now;
            recent.title = entry.title || recent.title;
            recent.favicon = entry.favicon || recent.favicon;
        } else {
            this.items.unshift({ url: entry.url, title: entry.title, favicon: entry.favicon, visitTime: now });
        }
        // 应用上限
        if (this.items.length > this.limit) {
            this.items = this.items.slice(0, this.limit);
        }
        await this.save();
    }

    async remove(url: string): Promise<void> {
        this.items = this.items.filter((h) => h.url !== url);
        await this.save();
    }

    async clearAll(): Promise<void> {
        this.items = [];
        await this.save();
    }

    /** 清空指定日期内的记录 */
    async clearByDate(date: Date): Promise<void> {
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const end = start + 24 * 60 * 60 * 1000;
        this.items = this.items.filter((h) => h.visitTime < start || h.visitTime >= end);
        await this.save();
    }

    /** 搜索 */
    search(keyword: string): HistoryEntry[] {
        if (!keyword.trim()) return this.list();
        const k = keyword.toLowerCase();
        return this.items.filter(
            (h) => h.url.toLowerCase().includes(k) || (h.title || "").toLowerCase().includes(k)
        );
    }

    /** 按日期分组（今天/昨天/7 天内/更早） */
    groupByDate(): { label: string; entries: HistoryEntry[] }[] {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
        const sevenDaysAgo = todayStart - 7 * 24 * 60 * 60 * 1000;

        const groups: Record<string, HistoryEntry[]> = {
            today: [],
            yesterday: [],
            last7: [],
            earlier: [],
        };
        for (const h of this.items) {
            if (h.visitTime >= todayStart) groups.today.push(h);
            else if (h.visitTime >= yesterdayStart) groups.yesterday.push(h);
            else if (h.visitTime >= sevenDaysAgo) groups.last7.push(h);
            else groups.earlier.push(h);
        }
        return [
            { label: "today", entries: groups.today },
            { label: "yesterday", entries: groups.yesterday },
            { label: "last7Days", entries: groups.last7 },
            { label: "earlier", entries: groups.earlier },
        ].filter((g) => g.entries.length > 0);
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
