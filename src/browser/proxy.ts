/**
 * 浏览器页签 webview session 的网络代理管理。
 *
 * 背景：webview 使用独立 partition（persist:siyuan-browser），Electron 的会话级代理
 * 配置互不继承 —— 思源本体在默认 session 上配置的代理（或内核的 networkProxy）
 * 不会自动作用到该会话。这里按插件设置显式调用 session.setProxy()，把
 * 「思源代理 / 系统代理 / 自定义代理」应用到 webview 会话。
 *
 * 应用范围：该 partition 下所有 webview 页签（共享同一 session），设置后立即生效，
 * 无需重启思源或重建页签。
 */
import { fetchSyncPost } from "siyuan";
import type { BrowserSettings, ProxyMode } from "../types";
import { BROWSER_PARTITION } from "../constants";
import { remoteSession } from "../utils/electron";

/** 思源代理配置（内核 getNetwork / conf.json networkProxy 同构） */
export interface ISiyuanProxy {
    scheme: string;
    host: string;
    port: string;
}

/** 读取思源内核配置的网络代理（未配置或读取失败返回 null）。 */
export async function getSiyuanProxy(): Promise<ISiyuanProxy | null> {
    // 首选内核 API：实时反映思源「设置 → 网络」中的当前值
    try {
        const resp: any = await fetchSyncPost("/api/system/getNetwork", {});
        const p = resp?.data?.proxy as Partial<ISiyuanProxy> | null | undefined;
        if (p) return { scheme: p.scheme || "", host: p.host || "", port: String(p.port || "") };
    } catch (e) {
        console.warn("[browser-plugin] getNetwork failed:", e);
    }
    // 兜底：渲染进程内存中的思源配置（window.siyuan.config 在启动/配置变更时由思源填充）
    try {
        const p = (window as any).siyuan?.config?.system?.networkProxy as Partial<ISiyuanProxy> | undefined;
        if (p) return { scheme: p.scheme || "", host: p.host || "", port: String(p.port || "") };
    } catch {
        // ignore
    }
    return null;
}

/** 便于日志展示的代理 URL（scheme=system/空 时不产生 URL） */
export function formatSiyuanProxyUrl(p: ISiyuanProxy | null): string | null {
    if (!p || !p.scheme || p.scheme === "system" || !p.host || !p.port) return null;
    return `${p.scheme}://${p.host}:${p.port}`;
}

/** session.setProxy 的配置对象（Electron ProxyConfig 子集） */
interface IProxyConfig {
    mode?: "direct" | "system" | "auto_detect" | "pac_script" | "fixed_servers";
    proxyRules?: string;
    proxyBypassRules?: string;
}

/** 按插件设置把代理应用到 webview 会话（persist:siyuan-browser）。 */
export async function applyProxyToSession(settings: BrowserSettings): Promise<boolean> {
    const session = remoteSession();
    if (!session?.setProxy) {
        console.warn("[browser-plugin] no session for setProxy (@electron/remote unavailable?)");
        return false;
    }
    const cfg = await buildProxyConfig(settings);
    try {
        await session.setProxy(cfg);
        console.log("[browser-plugin] webview proxy applied:", JSON.stringify(cfg));
        return true;
    } catch (e) {
        console.warn("[browser-plugin] setProxy failed:", e);
        return false;
    }
}

/**
 * 根据设置解析 setProxy 配置。
 * 思源模式的映射与思源 main.js 的 setProxy 语义完全一致：
 * scheme="system" → 系统代理；scheme 为空/未配置 → 直连；其余（http/https/socks5）→ proxyRules。
 */
async function buildProxyConfig(s: BrowserSettings): Promise<IProxyConfig> {
    const mode: ProxyMode = s.proxyMode || "system";

    if (mode === "siyuan") {
        const p = await getSiyuanProxy();
        if (p?.scheme === "system") return { mode: "system" };
        const url = formatSiyuanProxyUrl(p);
        if (url) return { proxyRules: url };
        // 思源未配置代理：与思源本体行为一致（直连）
        console.warn("[browser-plugin] SiYuan proxy not configured, webview falls back to direct");
        return { mode: "direct" };
    }

    if (mode === "custom") {
        const url = (s.proxyCustomUrl || "").trim();
        if (url) return { proxyRules: url };
        // 自定义地址为空：回退系统代理（与未设置代理时的 Chromium 默认行为一致）
        console.warn("[browser-plugin] custom proxy URL is empty, falls back to system proxy");
        return { mode: "system" };
    }

    // system：跟随系统代理设置（Chromium 默认行为）
    return { mode: "system" };
}
