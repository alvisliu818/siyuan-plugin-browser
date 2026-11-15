import { STORAGE_KEYS } from "../constants";

/** 一个网页对应的标注文档信息 */
export interface AnnotationPageInfo {
    /** 思源标注文档块 id（root_id） */
    docId: string;
    /** 文档标题（页面标题清洗后） */
    title: string;
    /** 网站域名 */
    domain: string;
    /** 首次标注时间 */
    createdAt: number;
}

/**
 * 网页标注索引：urlKey（去 hash 的完整 URL）→ 标注文档 id 映射。
 * 持久化在插件 storage（annotations.json）；标注正文本体存放在思源文档里
 * （结构：标注存放路径 → 网站域名 → 网页标注文档），这里只负责快速定位。
 */
export class AnnotationStore {
    private plugin: any;
    private pages: Record<string, AnnotationPageInfo> = {};

    constructor(plugin: any) {
        this.plugin = plugin;
    }

    async load(): Promise<void> {
        try {
            const data = await this.plugin.loadData(STORAGE_KEYS.annotations);
            if (data) {
                const parsed = typeof data === "string" ? JSON.parse(data) : data;
                this.pages = parsed?.pages || {};
            }
        } catch {
            this.pages = {};
        }
    }

    /** 规范化 urlKey：去掉 hash（SPA 锚点路由不单独建文档） */
    static normalizeKey(url: string): string {
        try {
            const u = new URL(url);
            return u.origin + u.pathname + u.search;
        } catch {
            return url.split("#")[0];
        }
    }

    find(urlKey: string): AnnotationPageInfo | null {
        return this.pages[urlKey] || null;
    }

    async upsert(urlKey: string, info: AnnotationPageInfo): Promise<void> {
        this.pages[urlKey] = info;
        try {
            await this.plugin.saveData(STORAGE_KEYS.annotations, JSON.stringify({ version: 1, pages: this.pages }));
        } catch (e) {
            console.warn("[browser-plugin] annotationStore persist failed:", e);
        }
    }
}
