import type { BrowserSettings } from "../types";
import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../constants";

export class SettingsStore {
    private plugin: any;
    private settings: BrowserSettings = { ...DEFAULT_SETTINGS };
    private listeners: Array<() => void> = [];

    constructor(plugin: any) {
        this.plugin = plugin;
    }

    async load(): Promise<void> {
        try {
            const data = await this.plugin.loadData(STORAGE_KEYS.settings);
            if (data) {
                const parsed = typeof data === "string" ? JSON.parse(data) : data;
                this.settings = { ...DEFAULT_SETTINGS, ...parsed };
            }
        } catch {
            this.settings = { ...DEFAULT_SETTINGS };
        }
    }

    async save(patch: Partial<BrowserSettings>): Promise<void> {
        this.settings = { ...this.settings, ...patch };
        await this.plugin.saveData(STORAGE_KEYS.settings, JSON.stringify(this.settings));
        this.notify();
    }

    get(): BrowserSettings {
        return { ...this.settings };
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
