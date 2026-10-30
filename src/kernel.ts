/**
 * 思源浏览器插件 - 内核插件入口
 *
 * 运行在思源内核 goja JS 引擎中，提供：
 * - download: 通过 /api/network/forwardProxy 抓取文件二进制，存到 assets 或插件 downloads
 * - fetchMeta: 抓取页面 HTML，提取 title/meta/favicon
 * - head: HTTP HEAD 探测（判断链接是页面还是下载）
 * - gmFetch: 油猴 GM_xmlhttpRequest / Edge 商店兜底下载通道（任意 http(s) 请求）
 *
 * 前端通过 this.kernel.rpc.call.* 调用本插件注册的方法。
 *
 * 关键契约（2026-10-29 实测定案）：
 * 1. /api/network/forwardProxy 响应是 JSON 信封 {code,msg,data:{status,contentType,
 *    body,bodyEncoding,headers}} —— body 按 responseEncoding 为 text/base64，
 *    绝不能把 HTTP 响应体直接当目标文件字节（旧版 download 因此存出坏文件）。
 * 2. /api/file/putFile 只收 multipart/form-data（JSON 体报 "path must not be
 *    empty" 且 HTTP 层仍 200 —— 必须检查响应 code），路径是工作空间相对路径：
 *    思源 assets 用 /data/assets/<name>，插件 downloads 用
 *    /data/storage/petal/<plugin>/downloads/<name>（旧版 /assets/... 会落到
 *    工作空间根，文件永远写不进资源库）。
 * 3. siyuan.storage.put 只收字符串（二进制会损坏），二进制一律走 putFile。
 */

const siyuan = (globalThis as any).siyuan;

interface IRpcResult {
    ok: boolean;
    data?: any;
    error?: string;
}

/** forwardProxy 统一响应形态（信封 data 字段展开） */
interface IForwardResult {
    status: number;
    contentType: string;
    body: string;
    encoding: string;
    headers: Record<string, string[]>;
}

const PLUGIN_NAME = "siyuan-plugin-browser";

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

    // ===== 基础设施 =====

    /**
     * 调 /api/network/forwardProxy 并解开响应信封。
     * 返回 data 为 {status, contentType, body, encoding, headers}；
     * code!==0 / 非信封响应一律 ok:false（避免上层把信封当业务数据）。
     */
    private async forwardProxy(url: string, opts: {
        method?: string;
        responseEncoding?: "text" | "base64";
        headers?: Record<string, string>;
        payload?: string;
        contentType?: string;
        timeout?: number;
    }): Promise<IRpcResult> {
        const options: any = {
            method: String(opts.method || "GET").toUpperCase(),
            timeout: opts.timeout ?? 30000,
            payload: opts.payload || "",
        };
        if (opts.responseEncoding) options.responseEncoding = opts.responseEncoding;
        if (opts.contentType) options.contentType = opts.contentType;
        const headerPairs: Array<Record<string, string>> = [];
        for (const k of Object.keys(opts.headers || {})) {
            headerPairs.push({ [k]: String(opts.headers![k]) });
        }
        if (headerPairs.length > 0) options.headers = headerPairs;
        if (options.payload && !options.contentType) {
            options.contentType = "application/x-www-form-urlencoded";
        }
        const resp = await this.siyuan.client.fetch("/api/network/forwardProxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, ...options }),
        });
        const text = await resp.text();
        let envelope: any;
        try {
            envelope = JSON.parse(text);
        } catch {
            return { ok: false, error: "forwardProxy unexpected response: " + String(text).slice(0, 200) };
        }
        if (!envelope || envelope.code !== 0) {
            return { ok: false, error: String(envelope?.msg || "forwardProxy failed") };
        }
        const d = envelope.data || {};
        return {
            ok: true,
            data: {
                status: d.status || 0,
                contentType: d.contentType || "",
                body: d.body || "",
                encoding: d.bodyEncoding || "text",
                headers: d.headers || {},
            } as IForwardResult,
        };
    }

    /** base64 → Uint8Array（goja 沙箱无 atob，自解码；标准字母表 + URL 安全兼容） */
    private base64ToBytes(b64: string): Uint8Array {
        const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const clean = String(b64 || "").replace(/[\r\n\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
        const len = clean.length;
        const padding = len >= 2 && clean.charAt(len - 1) === "=" ? (clean.charAt(len - 2) === "=" ? 2 : 1) : 0;
        const out = new Uint8Array(Math.floor(len / 4) * 3 - padding);
        let bytePos = 0;
        let buffer = 0;
        let bits = 0;
        for (let i = 0; i < len; i++) {
            const ch = clean.charAt(i);
            if (ch === "=") break;
            const idx = B64.indexOf(ch);
            if (idx < 0) continue;
            buffer = (buffer << 6) | idx;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[bytePos++] = (buffer >> bits) & 0xff;
            }
        }
        return out;
    }

    /**
     * 构造 /api/file/putFile 的 multipart/form-data 请求体（ArrayBuffer）。
     * goja 的 client.fetch 接受 ArrayBuffer；表单头是 ASCII，按 charCode 写字节。
     */
    private buildPutFileBody(absPath: string, filename: string, bytes: Uint8Array, modTime: number): { body: ArrayBuffer; contentType: string } {
        const boundary = "----syKernelBoundary" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const head =
            "--" + boundary + "\r\n" +
            'Content-Disposition: form-data; name="path"\r\n\r\n' + absPath + "\r\n" +
            "--" + boundary + "\r\n" +
            'Content-Disposition: form-data; name="isDir"\r\n\r\nfalse\r\n' +
            "--" + boundary + "\r\n" +
            'Content-Disposition: form-data; name="modTime"\r\n\r\n' + modTime + "\r\n" +
            "--" + boundary + "\r\n" +
            'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
            "Content-Type: application/octet-stream\r\n\r\n";
        const tail = "\r\n--" + boundary + "--\r\n";
        const total = head.length + bytes.length + tail.length;
        const arr = new Uint8Array(total);
        for (let i = 0; i < head.length; i++) arr[i] = head.charCodeAt(i) & 0xff;
        arr.set(bytes, head.length);
        const off = head.length + bytes.length;
        for (let i = 0; i < tail.length; i++) arr[off + i] = tail.charCodeAt(i) & 0xff;
        return { body: arr.buffer, contentType: "multipart/form-data; boundary=" + boundary };
    }

    /**
     * 写工作空间内文件（/api/file/putFile，multipart）。
     * 必须校验响应 code：HTTP 层恒 200，写失败（如 path 校验拒绝）只在 body code 里体现。
     */
    private async putWorkspaceFile(absPath: string, filename: string, bytes: Uint8Array, modTime: number): Promise<void> {
        const { body, contentType } = this.buildPutFileBody(absPath, filename, bytes, modTime);
        const resp = await this.siyuan.client.fetch("/api/file/putFile", {
            method: "POST",
            headers: { "Content-Type": contentType },
            body,
        });
        const text = await resp.text();
        let envelope: any;
        try {
            envelope = JSON.parse(text);
        } catch {
            throw new Error("putFile unexpected response: " + String(text).slice(0, 120));
        }
        if (!envelope || envelope.code !== 0) {
            throw new Error("putFile failed: " + String(envelope?.msg || text.slice(0, 120)));
        }
    }

    // ===== RPC 方法 =====

    private async registerRpcMethods(): Promise<void> {
        // 下载文件到 assets 或插件 downloads（二进制安全：forwardProxy base64 → 解码 → putFile 落盘）
        await this.siyuan.rpc.bind(
            "download",
            async (url: string, suggestedName: string, target: "assets" | "storage"): Promise<IRpcResult> => {
                try {
                    const r = await this.forwardProxy(url, { method: "GET", responseEncoding: "base64" });
                    if (!r.ok) return { ok: false, error: r.error };
                    const d = r.data as IForwardResult;
                    if (d.status < 200 || d.status >= 300) {
                        return { ok: false, error: `HTTP ${d.status} for ${url}` };
                    }
                    const bytes = this.base64ToBytes(d.body);
                    if (bytes.length === 0) {
                        return { ok: false, error: "downloaded body is empty" };
                    }
                    const filename = suggestedName || this.deriveFilename(url, d.headers);
                    const modTime = Math.floor(Date.now() / 1000);
                    if (target === "storage") {
                        // 插件存储（前端 showDownloadedInFolder 按 downloads/ 前缀映射到 petal 目录）
                        const absPath = `/data/storage/petal/${PLUGIN_NAME}/downloads/${filename}`;
                        await this.putWorkspaceFile(absPath, filename, bytes, modTime);
                        return { ok: true, data: { filename, savePath: `downloads/${filename}`, size: bytes.length } };
                    }
                    // 思源资源库 data/assets/
                    await this.putWorkspaceFile(`/data/assets/${filename}`, filename, bytes, modTime);
                    return { ok: true, data: { filename, savePath: `assets/${filename}`, size: bytes.length } };
                } catch (e: any) {
                    return { ok: false, error: String(e?.message || e) };
                }
            },
            "下载文件到思源"
        );

        // 抓取页面元数据
        await this.siyuan.rpc.bind(
            "fetchMeta",
            async (url: string): Promise<IRpcResult> => {
                try {
                    const r = await this.forwardProxy(url, { method: "GET", responseEncoding: "text" });
                    if (!r.ok) return { ok: false, error: r.error };
                    const d = r.data as IForwardResult;
                    const meta = this.parseMeta(d.body, url);
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
                    const r = await this.forwardProxy(url, { method: "HEAD" });
                    if (!r.ok) return { ok: false, error: r.error };
                    const d = r.data as IForwardResult;
                    return {
                        ok: true,
                        data: {
                            status: d.status,
                            statusText: "",
                            headers: this.headersToObj(d.headers),
                        },
                    };
                } catch (e: any) {
                    return { ok: false, error: String(e?.message || e) };
                }
            },
            "HTTP HEAD 探测"
        );

        // 油猴 GM_xmlhttpRequest / Edge 商店兜底下载通道（服务端转发，绕开跨域）
        await this.siyuan.rpc.bind(
            "gmFetch",
            async (url: string, method: string, headersJson: string, data: string, encoding: string): Promise<IRpcResult> => {
                try {
                    let headers: Record<string, string> = {};
                    try {
                        headers = headersJson ? JSON.parse(headersJson) : {};
                    } catch {}
                    const r = await this.forwardProxy(url, {
                        method,
                        headers,
                        payload: data || "",
                        responseEncoding: encoding === "base64" ? "base64" : "text",
                        timeout: 30000,
                    });
                    if (!r.ok) return { ok: false, error: r.error };
                    return { ok: true, data: r.data };
                } catch (e: any) {
                    return { ok: false, error: String(e?.message || e) };
                }
            },
            "油猴脚本 GM_xmlhttpRequest 通道"
        );
    }

    /** 从目标响应头（forwardProxy 信封 data.headers，map[string][]string）提取文件名 */
    private deriveFilename(url: string, headers: Record<string, string[]>): string {
        const cd = headers?.["Content-Disposition"] || headers?.["content-disposition"];
        if (cd && cd.length) {
            const m = cd.join("; ").match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
            if (m) return decodeURIComponent(m[1]);
        }
        try {
            const u = new URL(url);
            const last = u.pathname.split("/").filter(Boolean).pop();
            if (last) return decodeURIComponent(last);
        } catch {}
        return "download";
    }

    private headersToObj(headers: Record<string, string[]>): Record<string, string> {
        const out: Record<string, string> = {};
        if (!headers) return out;
        for (const k of Object.keys(headers)) {
            const v = headers[k];
            out[k] = Array.isArray(v) ? v.join(", ") : String(v);
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
