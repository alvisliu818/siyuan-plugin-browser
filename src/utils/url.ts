import { SEARCH_ENGINES } from "../constants";
import type { BrowserSettings } from "../types";

/**
 * 规范化用户在地址栏输入的内容：
 * - 含 "://" 当作 URL 直接返回
 * - 形如 "example.com"、"example.com/path" 补 https://
 * - 形如 "localhost:port" 补 http://
 * - 否则用默认搜索引擎搜索
 */
export function normalizeUrl(input: string, settings: BrowserSettings): string {
    const trimmed = input.trim();
    if (!trimmed) return "about:blank";

    // 已经是 URL
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
        return trimmed;
    }

    // about: 协议
    if (trimmed.startsWith("about:")) return trimmed;

    // 形如 example.com / example.com/path / 1.2.3.4
    if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(trimmed) || /^localhost(:\d+)?(\/.*)?$/.test(trimmed)) {
        return "https://" + trimmed;
    }

    // 视为搜索词
    return buildSearchUrl(trimmed, settings);
}

/** 构建搜索 URL */
export function buildSearchUrl(query: string, settings: BrowserSettings): string {
    let template: string;
    if (settings.searchEngine === "custom" && settings.customSearchUrl) {
        template = settings.customSearchUrl;
    } else {
        const engine = SEARCH_ENGINES.find((e) => e.id === settings.searchEngine) || SEARCH_ENGINES[0];
        template = engine.url;
    }
    return template.replace("{q}", encodeURIComponent(query));
}

/** 从 URL 中提取域名（用于 favicon 查询） */
export function getDomain(url: string): string {
    try {
        const u = new URL(url);
        return u.hostname;
    } catch {
        return "";
    }
}

/** 规范化显示 URL（去掉协议前缀，地址栏更简洁时用） */
export function prettyUrl(url: string): string {
    return url.replace(/^https?:\/\//, "");
}

/** 判断 URL 是否为有效的外部链接 */
export function isValidUrl(url: string): boolean {
    if (!url) return false;
    try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:";
    } catch {
        return false;
    }
}

/** 从 URL 推断下载文件名 */
export function getFilenameFromUrl(url: string): string {
    try {
        const u = new URL(url);
        const pathname = u.pathname;
        const last = pathname.split("/").filter(Boolean).pop();
        if (last) return decodeURIComponent(last);
        return u.hostname;
    } catch {
        return "download";
    }
}

/** 格式化字节数 */
export function formatBytes(bytes: number): string {
    if (bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return v.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

/** 格式化时间戳为可读字符串 */
export function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
