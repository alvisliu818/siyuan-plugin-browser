/**
 * 思源浏览器插件 - 内核插件入口
 *
 * 运行在思源内核 goja JS 引擎中，提供：
 * - fetchMeta: 抓取页面 HTML，提取 title/meta/favicon
 * - head: HTTP HEAD 探测（判断链接是页面还是下载）
 *
 * 前端通过 this.kernel.rpc.call.* 调用本插件注册的方法。
 */

const siyuan = (globalThis as any).siyuan;

interface IRpcResult {
    ok: boolean;
    data?: any;
    error?: string;
}

class BrowserKernelPlugin {
    private readonly siyuan: any;

    constructor() {
        this.siyuan = siyuan;
        if (!this.siyuan) {
            console.error("[browser-kernel] globalThis.siyuan not available");
            return;
        }
        this.siyuan.plugin.lifecycle.onload = this.onload.bind(this);
        this.siyuan.plugin.lifecycle.onrunning = this.onrunning.bind(this);
        this.siyuan.plugin.lifecycle.onunload = this.onunload.bind(this);
    }

    async onload(): Promise<void> {
        this.siyuan.logger?.info?.("[browser-kernel] loaded");
    }

    async onrunning(): Promise<void> {
        this.siyuan.logger?.info?.("[browser-kernel] running, registering RPC methods");
        await this.registerRpcMethods();
    }

    async onunload(): Promise<void> {
        this.siyuan.logger?.info?.("[browser-kernel] unloading");
        // 内核插件无需主动 unbind，框架会处理
    }

    private async registerRpcMethods(): Promise<void> {
        // 抓取页面元数据
        await this.siyuan.rpc.bind(
            "fetchMeta",
            async (url: string): Promise<IRpcResult> => {
                try {
                    const resp = await this.siyuan.client.fetch("/api/network/forwardProxy", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ url, method: "GET", payload: "" }),
                    });
                    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
                    const html = await resp.text();
                    const meta = this.parseMeta(html, url);
                    return { ok: true, data: meta };
                } catch (e: any) {
                    return { ok: false, error: String(e?.message || e) };
                }
            },
            "抓取页面元信息"
        );

        // HTTP HEAD 探测
        await this.siyuan.rpc.bind(
            "head",
            async (url: string): Promise<IRpcResult> => {
                try {
                    const resp = await this.siyuan.client.fetch("/api/network/forwardProxy", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ url, method: "HEAD", payload: "" }),
                    });
                    return {
                        ok: true,
                        data: {
                            status: resp.status,
                            statusText: resp.statusText,
                            headers: this.headersToObj(resp.headers),
                        },
                    };
                } catch (e: any) {
                    return { ok: false, error: String(e?.message || e) };
                }
            },
            "HTTP HEAD 探测"
        );
    }

    /** 将 HTTP 响应头对象转为普通对象 */
    private headersToObj(headers: any): Record<string, string> {
        const out: Record<string, string> = {};
        if (!headers) return out;
        if (typeof headers.forEach === "function") {
            headers.forEach((v: string, k: string) => (out[k] = v));
        } else if (typeof headers.entries === "function") {
            for (const [k, v] of headers.entries()) out[k] = v;
        } else {
            Object.assign(out, headers);
        }
        return out;
    }

    private parseMeta(html: string, baseUrl: string): { title: string; description: string; favicon: string; ogImage?: string } {
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : "";
        const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
        const description = descMatch ? descMatch[1] : "";
        const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        const ogImage = ogImageMatch ? ogImageMatch[1] : undefined;
        let favicon = "";
        const iconMatch = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i);
        if (iconMatch) {
            favicon = this.resolveUrl(iconMatch[1], baseUrl);
        } else {
            try {
                const u = new URL(baseUrl);
                favicon = `${u.origin}/favicon.ico`;
            } catch {}
        }
        return { title, description, favicon, ogImage };
    }

    private resolveUrl(href: string, base: string): string {
        try {
            return new URL(href, base).href;
        } catch {
            return href;
        }
    }
}

new BrowserKernelPlugin();

export {};
