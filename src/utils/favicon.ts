import { FAVICON_SERVICE } from "../constants";
import { getDomain } from "./url";

/** 根据页面 URL 获取 favicon 链接（优先用站点自身 favicon.ico） */
export function getFaviconUrl(pageUrl: string): string {
    try {
        const u = new URL(pageUrl);
        return `${u.origin}/favicon.ico`;
    } catch {
        const domain = getDomain(pageUrl);
        if (!domain) return "";
        return FAVICON_SERVICE.replace("{domain}", domain);
    }
}

/** 给定 url 和已有候选 favicon 列表，返回最合适的一个 */
export function pickFavicon(pageUrl: string, candidates: string[]): string {
    for (const c of candidates) {
        if (c && /^https?:\/\//.test(c)) return c;
    }
    return getFaviconUrl(pageUrl);
}
