/**
 * Microsoft Edge 加载项商店（https://microsoftedge.microsoft.com/addons）扩展获取。
 *
 * - 详情页 URL 形如 https://microsoftedge.microsoft.com/addons/detail/<slug>/<id>，
 *   id 为 32 位 [a-p] 字符串；也接受裸 id。
 * - CRX 直链（Edge 浏览器安装扩展时使用的 ondemand 接口，与 Chrome Web Store 的
 *   update2/crx 同构）：
 *     https://edge.microsoft.com/extensionwebstorebase/v1/crx
 *       ?response=redirect&prod=chromiumcrx&prodchannel=
 *       &x=id%3D<id>%26installsource%3Dondemand%26uc
 *   注意 x 参数必须整体 URL 编码（实测裸拼 & 分隔会返回 400）。
 *   该接口 30x 重定向到微软 CDN（http://msedgeextensions.f.tlu.dl.delivery.mp.microsoft.com/...），
 *   因此下载实现必须跟随 https→http 的跨协议重定向。
 * - 元数据接口：https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/<id>
 *   返回 JSON（name / description / activeInstallCount 等），仅用于展示与命名，失败可容忍。
 *
 * 下载用 Node http/https（渲染进程 nodeIntegration 下经 window.require 获取；
 * 纯 Node 测试环境预置 globalThis.window = { require } 即可复用）。
 */

/** 商店首页（在插件浏览器内浏览、点扩展安装的入口） */
export const EDGE_ADDONS_HOME = "https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home";

/** Edge/Chrome 扩展 id 字符集固定为 a-p 共 16 个字母 */
const ADDON_ID_RE = /^[a-p]{32}$/i;
/** 详情页 https://microsoftedge.microsoft.com/addons/detail/<slug>/<id>（slug 可省略） */
const DETAIL_URL_RE = /microsoftedge\.microsoft\.com\/addons\/detail\/(?:[^/?#]+\/)?([a-p]{32})/i;
/** CRX 直链（商店"获取"按钮的另一种落点） */
const CRX_URL_RE = /^https?:\/\/edge\.microsoft\.com\/extensionwebstorebase\/v1\/crx/i;

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 8;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** 伪装 Edge 浏览器 UA：商店页会 UA 嗅探（非 Edge 直接禁用「获取」按钮并提示不兼容），下载接口同样带上 */
export const EDGE_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

export interface IEdgeAddonMeta {
    name?: string;
    description?: string;
    activeInstallCount?: number;
    [key: string]: any;
}

export interface IDownloadOptions {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    onProgress?: (received: number, total: number) => void;
}

/** 从 Edge 加载项详情页链接或裸扩展 ID 中解析出 32 位扩展 id */
export function parseEdgeAddonId(input: string): string | null {
    const s = String(input || "").trim();
    if (!s) return null;
    if (ADDON_ID_RE.test(s)) return s.toLowerCase();
    const m = s.match(DETAIL_URL_RE);
    if (m) return m[1].toLowerCase();
    return null;
}

/**
 * 从商店"获取"按钮触发的导航落点解析扩展 id（在插件内点获取即安装）：
 * - microsoft-edge: 协议跳转（非 Edge 浏览器中"获取"按钮的默认行为）
 *   形如 microsoft-edge:https://microsoftedge.microsoft.com/addons/detail/<slug>/<id>
 *   或 microsoft-edge:addons/detail/<slug>/<id>
 * - CRX 直链导航 https://edge.microsoft.com/extensionwebstorebase/v1/crx?...&x=id%3D<id>%26...
 * 其余返回 null。
 */
export function parseEdgeInstallNavigation(url: string): string | null {
    const s = String(url || "").trim();
    if (!s) return null;
    if (/^microsoft-edge:/i.test(s)) {
        const rest = s.slice("microsoft-edge:".length);
        const m = rest.match(/addons\/detail\/(?:[^/?#]+\/)?([a-p]{32})/i);
        return m ? m[1].toLowerCase() : null;
    }
    if (CRX_URL_RE.test(s)) {
        try {
            const x = new URL(s).searchParams.get("x") || "";
            const m = x.match(/id=([a-p]{32})/i);
            return m ? m[1].toLowerCase() : null;
        } catch {
            return null;
        }
    }
    return null;
}

/** CRX ondemand 下载直链 */
export function edgeCrxUrl(id: string): string {
    const x = `id=${id}&installsource=ondemand&uc`;
    return (
        "https://edge.microsoft.com/extensionwebstorebase/v1/crx" +
        `?response=redirect&prod=chromiumcrx&prodchannel=&x=${encodeURIComponent(x)}`
    );
}

/** 商店元数据接口 */
export function edgeMetaUrl(id: string): string {
    return `https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/${id}`;
}

function nodeModules() {
    const req = (window as any).require;
    if (!req) {
        throw new Error("node require unavailable (nodeIntegration disabled?)");
    }
    return {
        http: req("http") as typeof import("http"),
        https: req("https") as typeof import("https"),
    };
}

/**
 * GET 并手动跟随重定向（允许 https↔http 跨协议，微软 CDN 最终落点是 http）。
 * 成功解析出 200 响应体；4xx/5xx、超限、超时均 reject。
 */
function httpGetBuffer(
    url: string,
    opts: Required<Pick<IDownloadOptions, "maxBytes" | "timeoutMs" | "maxRedirects">> & IDownloadOptions
): Promise<{ status: number; buffer: Buffer; finalUrl: string }> {
    return new Promise((resolve, reject) => {
        const { http, https } = nodeModules();
        const step = (currentUrl: string, redirects: number) => {
            const mod = currentUrl.startsWith("https:") ? https : http;
            const req = mod.get(
                currentUrl,
                { headers: { "User-Agent": EDGE_UA, Accept: "*/*" } },
                (res) => {
                    const status = res.statusCode || 0;
                    if (REDIRECT_STATUSES.includes(status)) {
                        res.resume();
                        const loc = res.headers.location;
                        if (!loc) {
                            reject(new Error(`redirect ${status} without Location header`));
                            return;
                        }
                        if (redirects >= opts.maxRedirects) {
                            reject(new Error(`too many redirects (> ${opts.maxRedirects})`));
                            return;
                        }
                        step(new URL(loc, currentUrl).toString(), redirects + 1);
                        return;
                    }
                    if (status !== 200) {
                        res.resume();
                        reject(new Error(`HTTP ${status} for ${currentUrl}`));
                        return;
                    }
                    const total = Number(res.headers["content-length"] || 0);
                    const chunks: Buffer[] = [];
                    let received = 0;
                    res.on("data", (c: Buffer) => {
                        received += c.length;
                        if (received > opts.maxBytes) {
                            req.destroy(new Error(`download exceeds size limit (${opts.maxBytes} bytes)`));
                            return;
                        }
                        chunks.push(c);
                        opts.onProgress?.(received, total);
                    });
                    res.on("end", () => resolve({ status, buffer: Buffer.concat(chunks), finalUrl: currentUrl }));
                    res.on("error", reject);
                }
            );
            req.on("error", reject);
            req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`request timeout (${opts.timeoutMs}ms)`)));
        };
        step(url, 0);
    });
}

/** 获取商店元数据（名称/描述/安装量）。接口不可用或 id 无效时返回 null，不抛错。 */
export async function fetchEdgeAddonMeta(id: string): Promise<IEdgeAddonMeta | null> {
    try {
        const { buffer } = await httpGetBuffer(edgeMetaUrl(id), {
            maxBytes: 2 * 1024 * 1024,
            timeoutMs: 15_000,
            maxRedirects: 4,
        });
        const data = JSON.parse(buffer.toString("utf8"));
        return data && typeof data.name === "string" ? data : null;
    } catch {
        return null;
    }
}

/**
 * 下载扩展 CRX 包（CRX3，魔数 Cr24）。部分渠道可能以 ZIP 分发，一并接受。
 * 非 CRX/ZIP 响应（错误页、限流页）直接报错。
 */
export async function downloadEdgeCrx(id: string, opts: IDownloadOptions = {}): Promise<Buffer> {
    const { buffer } = await httpGetBuffer(edgeCrxUrl(id), {
        maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
        onProgress: opts.onProgress,
    });
    const magic = buffer.toString("latin1", 0, 4);
    if (magic !== "Cr24" && magic !== "PK\x03\x04") {
        throw new Error("response is not a CRX/ZIP package (bad magic: " + JSON.stringify(magic) + ")");
    }
    return buffer;
}

/**
 * 内核 RPC 通道的最小接口（gmFetch，见 kernel.ts）。
 * 通过 any 引用避免前端 bundle 依赖内核类型。
 */
export interface IKernelGmFetch {
    gmFetch(url: string, method: string, headersJson: string, data: string, encoding: string): Promise<any>;
}

/**
 * 带内核兜底的 CRX 下载：渲染进程的 Node http/https 不走系统/插件代理，
 * 直连微软商店被网络环境重置（ECONNRESET）时，改经内核 forwardProxy 下载
 * （base64 回传；CDN 302 由内核 req 客户端自动跟随）。
 */
export async function downloadEdgeCrxWithFallback(
    id: string,
    kernelRpc: IKernelGmFetch | null | undefined,
    opts: IDownloadOptions = {}
): Promise<Buffer> {
    try {
        return await downloadEdgeCrx(id, opts);
    } catch (directErr) {
        if (!kernelRpc?.gmFetch) throw directErr;
        const r = await kernelRpc.gmFetch(edgeCrxUrl(id), "GET", "{}", "", "base64");
        if (!r?.ok) {
            throw new Error(
                `direct download failed (${String((directErr as Error)?.message || directErr)}), ` +
                `kernel download failed: ${String(r?.error || "unknown")}`
            );
        }
        const buf = Buffer.from(String(r.data?.body || ""), "base64");
        if (buf.length < 8) {
            throw new Error("kernel download returned an empty body");
        }
        const magic = buf.toString("latin1", 0, 4);
        if (magic !== "Cr24" && magic !== "PK\x03\x04") {
            throw new Error("kernel download is not a CRX/ZIP package (bad magic: " + JSON.stringify(magic) + ")");
        }
        return buf;
    }
}
