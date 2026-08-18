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

/**
 * 判断单个 hostname 是否匹配某个模式。
 * - 模式以 `*.` 开头：仅匹配子域名（如 `*.weibo.com` 匹配 `www.weibo.com`，不匹配 `weibo.com`）
 * - 否则：精确匹配 hostname，或匹配其任意子域名（如 `weibo.com` 匹配 `weibo.com`、`www.weibo.com`）
 */
function matchHost(hostname: string, pattern: string): boolean {
    hostname = hostname.toLowerCase();
    pattern = pattern.toLowerCase();
    if (pattern.startsWith("*.")) {
        const base = pattern.slice(2);
        return !!base && hostname.endsWith("." + base);
    }
    return hostname === pattern || hostname.endsWith("." + pattern);
}

/**
 * 检查 URL 是否匹配排除列表中的任一模式。
 * patternsText 按行分隔，每行一个 hostname；空行和 `#` 开头的行视为注释。
 * 匹配的 URL 应在系统默认浏览器打开，而非插件。
 */
export function isUrlExcluded(url: string, patternsText: string): boolean {
    if (!patternsText) return false;
    const hostname = getDomain(url);
    if (!hostname) return false;
    const patterns = patternsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
    for (const p of patterns) {
        if (matchHost(hostname, p)) return true;
    }
    return false;
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

/** 格式化时间戳为可读字符串 */
export function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
