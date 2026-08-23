import type { DownloadItem, DownloadState } from "../types";
import { STORAGE_KEYS } from "../constants";
import { uid } from "../utils/dom";

export class DownloadsStore {
    private plugin: any;
    private items: DownloadItem[] = [];
    private listeners: Array<() => void> = [];

    constructor(plugin: any) {
        this.plugin = plugin;
    }

    async load(): Promise<void> {
        try {
            const data = await this.plugin.loadData(STORAGE_KEYS.downloads);
            this.items = data ? (typeof data === "string" ? JSON.parse(data) : data) : [];
        } catch {
            this.items = [];
        }
    }

    async save(): Promise<void> {
        await this.plugin.saveData(STORAGE_KEYS.downloads, JSON.stringify(this.items));
        this.notify();
    }

    list(): DownloadItem[] {
        return [...this.items];
    }

    get(id: string): DownloadItem | undefined {
        return this.items.find((d) => d.id === id);
    }

    async create(input: { url: string; filename: string; total?: number }): Promise<DownloadItem> {
        const item: DownloadItem = {
            id: uid(),
            url: input.url,
            filename: input.filename,
            savePath: "",
            total: input.total ?? 0,
            received: 0,
            state: "in_progress",
            startedAt: Date.now(),
        };
        this.items.unshift(item);
        await this.save();
        return item;
    }

    async update(id: string, patch: Partial<DownloadItem>): Promise<void> {
        const idx = this.items.findIndex((d) => d.id === id);
        if (idx < 0) return;
        this.items[idx] = { ...this.items[idx], ...patch };
        await this.save();
    }

    async setState(id: string, state: DownloadState, error?: string): Promise<void> {
        await this.update(id, {
            state,
            error,
            ...(state === "completed" || state === "interrupted" || state === "canceled"
                ? { finishedAt: Date.now() }
                : {}),
        });
    }

    async remove(id: string): Promise<void> {
        this.items = this.items.filter((d) => d.id !== id);
        await this.save();
    }

    async clearCompleted(): Promise<void> {
        this.items = this.items.filter((d) => d.state !== "completed");
        await this.save();
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
