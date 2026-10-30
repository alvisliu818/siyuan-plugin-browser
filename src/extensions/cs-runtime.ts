/**
 * 内容脚本 chrome.* API 真实绑定（webContents.debugger 版）。
 *
 * 根因（2026-10-10 实测定案）：Electron 对 content script 的扩展 API 注入只做了
 * 命名空间占位 —— isolated world 的 chrome 对象 {dom,i18n,runtime,storage} 键存在、
 * 值全是 undefined，content script 顶层一碰 chrome.storage 就抛 TypeError。
 * 页面内垫片补不了：CS 在我们注入前就死了，且 isolated world 由 Chromium C++ 创建。
 *
 * 方案：不修 Electron 的世界，自建世界。
 * 1. 传输层用 webContents.debugger（@electron/remote 拿到 webview 的 webContents）：
 *    进程内 CDP，不依赖 --remote-debugging-port；渲染进程的浏览器 WebSocket 连
 *    ws://127.0.0.1 会被 https 页面混合内容策略拦截（实测），debugger API 无此问题。
 * 2. dom-ready 时对每个原生加载、且内容脚本引用 chrome.* 的扩展：
 *    Page.createIsolatedWorld（grantUniversalAccess）→ 专属世界（命名
 *    __syCsRt_<electronId>，evalInExtensionWorld 按 name 优先匹配）；
 * 3. Runtime.addBinding 注入 __syExtHost 桥（CS→宿主方向）+ Runtime.evaluate
 *    注入完整 chrome.runtime / chrome.storage / chrome.i18n 实现 ——
 *    异步操作经桥到宿主，宿主经扩展 SW 的真实 chrome.storage 代答
 *    （SW 通道走 sw-bridge 的 Node WebSocket，sync/session 代理到 local）；
 * 4. chrome.runtime.sendMessage 经 SW 垫片 v4 的 storage 路由（__syRouteIn /
 *    __syRouteResp_<id>）往返 —— 与 SW 侧收集的 onMessage handlers 配对；
 * 5. 内容脚本入口文件从磁盘读出后在该世界执行 —— chrome API 全程可用，
 *    顶层初始化不再抛错。manifest 的 content_scripts 已被宿主清空（根源方案：
 *    Chromium 152 原生副本非空壳，sync 调用抛错 + 与自建世界双份竞争），原生
 *    世界不再有任何副本 —— 自建世界全量接管 js 执行与 css 注入；
 *    时序折衷：原生 document_start 型脚本统一在 dom-ready 后执行。
 *
 * 时序：世界由宿主创建、CS 由宿主执行 —— 没有竞速问题；同进程导航会话不断开
 * （frameNavigated 换 frameId 后重建世界），跨进程导航/页签销毁由 detach 事件
 * 与 disposeCsRuntime 清理。
 */
import type { IWebviewTag } from "../types";
import { fetchSyncPost } from "siyuan";
import { CLIP_DEFAULT_TEMPLATE, renderClipTemplate, getDefaultClipMarkdown, formatClipExcerpt } from "../browser/excerpt";
import { CS_WORLD_PREFIX, cdpEvalOnce, cdpHttpLikelyDead, evalInSwFlat, evalInSwFlatCached, findSwFlatSession, findSwTarget, FlatCommandSender, SW_FLAT_UNAVAILABLE } from "./sw-bridge";

const BRIDGE_NAME = "__syExtHost";
/** popup/options 页专属世界前缀（独立于 content 世界，避免顶层声明冲突） */
const POPUP_WORLD_PREFIX = "__syCsPop_";
/** Clip 自定义剪藏模板缓存（模块级：manager（seed 预读）与 CsPageSession（剪藏直用）共享） */
const clipTemplateCache = new Map<string, string>();

/** SW→CS 回程监听窗口时长（routeSendMessage 派发后轮询 SW 垫片 outbox 的时间上限）。
 *  剪藏大流程（多图下载）可远超短窗口且中途可能无 tip → 窗口必须覆盖全程，
 *  否则最后的完成 tip（tip_clip_ok）在窗口关闭后进 outbox 无人接驳，滞留到
 *  下一次剪藏开泵才补显（"剪藏成功了过很久才提醒"）。空转开销 = 每 600ms 一次
 *  轻量 drain（有消息时经活跃续期顺延；SW 空闲回收后连续失败自动停泵）。 */
const SW_REPLY_WINDOW_MS = 300_000;
/** 取走 SW 垫片 v13 __syTabsOutbox 里待发往 content 世界的消息（原子取走） */
const SW_TABS_DRAIN_EXPR = `(() => { const out = self.__syTabsOutbox || []; self.__syTabsOutbox = []; return JSON.stringify(out); })()`;

export interface ICsExtInfo {
    electronId: string;
    path: string;
    name: string;
    version: string;
    defaultLocale: string;
    contentScripts: Array<{ matches: string[]; js: string[]; css: string[] }>;
    /**
     * 该世界的 sender 身份 URL（port.sender.url / sendMessage sender）。
     * popup/扩展页面世界必须传 chrome-extension://<id>/<page>：真 Chrome 里
     * 弹出面板是真实扩展文档（location.href 即扩展 URL），而我们的 popup
     * 世界寄生在宿主页面里 —— TM/AdGuard 的 SW 端按 sender.url 判
     * extpage 白名单（不以 chrome-extension:// 开头即静默丢弃消息，面板
     * 永远等不到回包）。缺省回退 location.href（内容脚本世界语义正确）。
     */
    senderPageUrl?: string;
    /**
     * 内容世界（content/用户脚本世界）的 tab 身份：真 Chrome 里内容脚本的
     * port.sender / message.sender 带 tab: {id}，TM 等 SW 端靠它把连接归属到
     * 页签（无 tab → 页签永远"无脚本状态"）。与垫片 tabs.query 的固定 id=1
     * 对齐。popup/扩展页面世界不设（真 Chrome 里 popup 的 sender 无 tab）。
     */
    senderTabId?: number;
}

/** 宿主能力提供者（extensionHost 实现），避免模块循环依赖 */
export interface ICsRuntimeHost {
    listNativeExts(): ICsExtInfo[];
    readFile(extPath: string, rel: string): string;
    messages(extPath: string, defaultLocale: string): Record<string, any>;
    /** 唤醒单个扩展 SW（removeExtension + loadExtension），返回回传的（可能更新过的）id */
    wakeOne(electronId: string): Promise<string | null>;
    /** 无副作用唤醒 SW（startWorkerForScope，不卸载扩展）——正在打开的扩展
     *  面板世界会随 removeExtension 被销毁（binding 失效 → hostCall 永挂），
     *  面板/存储路径的唤醒必须用这个 */
    wakeSw?(electronId: string): Promise<void>;
    /** 新标签页扩展数据适配：topSites/bookmarks/history 由插件历史/书签库代答 */
    userData?(kind: string, args: any): Promise<any>;
}

let manager: CsRuntimeManager | null = null;

export function initCsRuntime(host: ICsRuntimeHost): void {
    manager = new CsRuntimeManager(host);
}

export function ensureCsRuntime(webview: IWebviewTag): void {
    manager?.ensure(webview).catch((e) => {
        console.warn("[browser-plugin] cs-runtime ensure failed:", e);
    });
}

export function disposeCsRuntime(webview: IWebviewTag): void {
    manager?.disposeFor(webview);
}

/**
 * 面板打开时把"当前页签"喂给扩展 SW（tabevent 通道）。
 * TM 的 popup 自己不调 chrome.tabs.query —— 它的 loadTree 靠 SW 侧
 * getSelected()（tabs.query({active,lastFocusedWindow})）解析当前页签；
 * Electron 原生 query 查不到（垫片 5-pre 以 __syLastFedTab 兜底），而
 * tabevent 此前只在 popup 世界调 tabs.query 时才喂 —— TM 不调就永远喂不进，
 * loadTree 无 tab 上下文（面板显示 no access、脚本状态全丢）。AdGuard 的
 * popup 自己会调 tabs.query，所以只有 TM 需要 host 主动喂。
 */
export async function feedTabEventForPopup(webview: IWebviewTag, ext: ICsExtInfo, url: string, title: string): Promise<void> {
    if (!manager) {
        console.warn("[browser-plugin] feedTab: cs-runtime manager 未初始化");
        return;
    }
    try {
        await manager.feedTabEvent(webview, ext, url, title);
        console.log("[browser-plugin] feedTab ok:", String(url).slice(0, 60), "ext:", ext.electronId.slice(0, 8));
    } catch (e) {
        console.warn("[browser-plugin] feedTab FAILED:", String((e as any)?.message || e).slice(0, 160));
    }
}

/** 把当前内核地址与 API token 播种到 SiYuan Clip 扩展配置（SW storage.local 的 ip/token）：
 *  每个工作空间内核端口与 token 各不相同，扩展里的静态配置必然失效 —— 宿主按当前
 *  内核真实值自动填充，其余配置项不动；值已一致时跳过写（幂等，减少 onChanged 噪音）。 */
export function seedExtensionKernelSettings(): Promise<void> {
    if (!manager) return Promise.resolve();
    return manager.seedExtensionKernelSettings();
}

/** popup eval 轨迹（主窗口可读；用于判断是否所有脚本落在同一个世界） */
function traceEval(entry: { ctxId: number; len: number; ok: boolean; err?: string }): void {
    try {
        const log = ((window as any).__syPopupLog = (window as any).__syPopupLog || []);
        log.push({ ts: Date.now(), ...entry });
        if (log.length > 40) log.splice(0, log.length - 40);
    } catch (e) {}
}

/** 开始一次 popup 会话：新建专属世界（同一次打开的后续 eval 共享该世界） */
export async function beginPopupWorld(webview: IWebviewTag, ext: ICsExtInfo): Promise<void> {
    if (!manager) return;
    await manager.beginPopup(webview, ext).catch((e) => {
        console.warn("[browser-plugin] beginPopupWorld failed:", e);
    });
}

/**
 * 在当前 popup 会话的世界里执行表达式（需先 beginPopupWorld）。
 * chrome.* 经桥真实可用；DOM 与页面共享。
 */
export async function evalPopupJs(webview: IWebviewTag, ext: ICsExtInfo, expr: string): Promise<{ ok: boolean; value?: any; error?: string }> {
    if (!manager) return { ok: false, error: "cs-runtime 未初始化" };
    return manager.evalPopupJs(webview, ext, expr);
}

// ===== Chrome match pattern（与 extensionHost 同款，独立副本避免模块循环） =====

function matchesUrlPattern(pattern: string, rawUrl: string): boolean {
    if (pattern === "<all_urls>") return /^https?:\/\//i.test(rawUrl);
    const m = pattern.match(/^(\*|https?|file|ftp|urn):\/\/(\*(?:\.[^/*]+)?|\*|[^/*]+)(\/.*)$/);
    if (!m) return false;
    const [, scheme, hostPat, pathPat] = m;
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }
    const urlScheme = url.protocol.replace(":", "");
    if (scheme === "*") {
        if (urlScheme !== "http" && urlScheme !== "https") return false;
    } else if (scheme !== urlScheme) {
        return false;
    }
    const host = url.hostname;
    const hostWithPort = url.host;
    const hostMatches = (pat: string) => pat === host || pat === hostWithPort;
    if (hostPat === "*") {
        // 任意主机
    } else if (hostPat.startsWith("*.")) {
        const base = hostPat.slice(2);
        if (!hostMatches(base) && !host.endsWith("." + base) && !hostWithPort.endsWith("." + base)) return false;
    } else if (!hostMatches(hostPat)) {
        return false;
    }
    const path = url.pathname + url.search;
    const regex = new RegExp("^" + pathPat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return regex.test(path);
}

// ===== webview → webContents（@electron/remote） =====

function remoteWebContents(webview: IWebviewTag): any | null {
    try {
        const req = (window as any).require;
        const remote = req?.("@electron/remote");
        const wid = (webview as any).getWebContentsId?.();
        if (!remote?.webContents?.fromId || wid == null) return null;
        const wc = remote.webContents.fromId(wid);
        return wc && !wc.isDestroyed?.() ? wc : null;
    } catch {
        return null;
    }
}

// ===== 世界/会话管理 =====

class CsRuntimeManager {
    private host: ICsRuntimeHost;
    /** webContents.id → 会话 */
    private sessions = new Map<string, CsPageSession>();

    constructor(host: ICsRuntimeHost) {
        this.host = host;
    }

    async ensure(webview: IWebviewTag): Promise<void> {
        const pageUrl = safeUrl(webview);
        if (!/^https?:\/\//i.test(pageUrl)) return;
        const wc = remoteWebContents(webview);
        if (!wc) {
            console.warn("[browser-plugin] cs-runtime: webContents 不可用（@electron/remote/getWebContentsId 失败）");
            return;
        }
        const key = String(wc.id);
        const existing = this.sessions.get(key);
        if (existing && existing.alive) {
            existing.pageUrl = pageUrl;
            await existing.sync();
            return;
        }
        const s = new CsPageSession(wc, pageUrl, this.host, () => this.sessions.delete(key));
        this.sessions.set(key, s);
        await s.start();
        await s.sync();
    }

    disposeFor(webview: IWebviewTag): void {
        const wc = remoteWebContents(webview);
        if (!wc) return;
        const key = String(wc.id);
        const s = this.sessions.get(key);
        if (s) {
            s.close();
            this.sessions.delete(key);
        }
    }

    private async sessionFor(webview: IWebviewTag): Promise<CsPageSession> {
        const pageUrl = safeUrl(webview);
        const wc = remoteWebContents(webview);
        if (!wc) throw new Error("webContents 不可用");
        const key = String(wc.id);
        let s = this.sessions.get(key);
        if (!s || !s.alive) {
            s = new CsPageSession(wc, pageUrl, this.host, () => this.sessions.delete(key));
            this.sessions.set(key, s);
            await s.start();
        }
        s.pageUrl = pageUrl;
        return s;
    }

    /** 开始一次 popup 会话：为该扩展新建专属世界（每次调用都新建，防跨打开声明冲突） */
    /** 面板打开时主动喂 tabevent（TM 不调 tabs.query，见 feedTabEventForPopup） */
    async feedTabEvent(webview: IWebviewTag, ext: ICsExtInfo, url: string, title: string): Promise<void> {
        const s = await this.sessionFor(webview);
        await s.feedTabEventToSw(ext, { url, title });
    }

    async beginPopup(webview: IWebviewTag, ext: ICsExtInfo): Promise<void> {        const dbg = (msg: any) => {
            try {
                (window as any).__syPopupDbg = { ts: Date.now(), ext: ext.name, ...(typeof msg === "object" ? msg : { msg }) };
            } catch (e) {}
        };
        const s = await this.sessionFor(webview);
        // frameId 可能在导航后变陈旧（世界会挂到失效 frame 上 → 后续 evaluate 无效果），
        // 建世界前重新取一次，并在建完后探测存活，失败则刷新重建一次
        await s.refreshFrameId().catch(() => {});
        let ctxId = await s.ensurePopupWorld(ext);
        const alive = await s.probeWorld(ctxId);
        if (!alive) {
            await s.refreshFrameId().catch(() => {});
            ctxId = await s.ensurePopupWorld(ext);
            const alive2 = await s.probeWorld(ctxId);
            dbg({ ok: true, begin: true, ctxId, retried: !alive2 ? "dead" : "ok" });
            return;
        }
        dbg({ ok: true, begin: true, ctxId });
    }

    async evalPopupJs(webview: IWebviewTag, ext: ICsExtInfo, expr: string): Promise<{ ok: boolean; value?: any; error?: string }> {
        // 页面任意 URL（含 about:blank / data: 查看源代码页）都可承载 popup ——
        // 传输走 webContents.debugger，与页面类型无关；仅 content script 注入限定 http(s)
        const dbg = (msg: any) => {
            try {
                (window as any).__syPopupDbg = { ts: Date.now(), ext: ext.name, ...(typeof msg === "object" ? msg : { msg }) };
            } catch (e) {}
        };
        try {
            const s = await this.sessionFor(webview);
            const ctxId = s.currentPopupCtx(ext.electronId);
            if (!ctxId) return { ok: false, error: "popup 世界未初始化（未 begin）" };
            const r = await s.evaluateInWorld(ctxId, expr);
            dbg({ ...r, ctxId });
            traceEval({ ctxId, len: expr.length, ok: r.ok, err: r.error });
            return r;
        } catch (e: any) {
            const err = String(e?.message || e);
            dbg({ ok: false, error: err });
            return { ok: false, error: err };
        }
    }

    /** manager 级 SW eval：任一存活会话（HTTP→flat 双通道）→ 主窗口兜底。
     *  兜底必须带 wake：load 时段通常没有任何 webview 会话，且 loadExtension
     *  不自动拉起 MV3 SW —— 无唤醒的主窗口兜底在 SW 未运行时永远查不到
     *  target（实测内核地址播种 10 轮重试全败的根因）。 */
    async evalInSwAny(electronId: string, expr: string): Promise<{ value?: any; err?: string }> {
        for (const s of this.sessions.values()) {
            if (!s.alive) continue;
            const r = await s.evalInSw({ electronId } as ICsExtInfo, expr);
            if (r.err !== SW_FLAT_UNAVAILABLE || r.value !== undefined) return r;
            // 该会话两条通道都不可用 → 换下一个
        }
        return await evalInSwViaMainWindow(electronId, expr, async () => {
            try { await this.host.wakeSw?.(electronId); } catch {}
        });
    }

    /** 播种当前内核地址/token 到 SiYuan Clip 配置（SW storage.local 的 ip/token）：
     *  每个工作空间端口与 token 不同，静态配置必然失效 —— 按当前内核真实值填充；
     *  值已一致时跳过写。启动时 SW 冷启动窗口期内首次写入可能全链失败 →
     *  3s 间隔退避重试（最多 10 次），成功即止。 */
    async seedExtensionKernelSettings(): Promise<void> {
        const port = window.location.port;
        if (!port) return;
        const ip = "http://127.0.0.1:" + port;
        let token = "";
        try { token = String((window as any).siyuan?.config?.api?.token || ""); } catch {}
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                const clip = this.host.listNativeExts().find((e) => e.name === "SiYuan");
                if (clip) {
                    // loadExtension 不自动拉起 MV3 SW —— 写入前先无副作用唤醒
                    //（startWorkerForScope；SW 已运行时为 no-op）
                    await this.host.wakeSw?.(clip.electronId);
                    const expr = `(async () => {
                        const cur = await chrome.storage.local.get(["ip", "token", "clipTemplate"]);
                        const patch = {};
                        const wantIp = ${JSON.stringify(ip)};
                        const wantToken = ${JSON.stringify(token)};
                        if (cur.ip !== wantIp) patch.ip = wantIp;
                        if (wantToken && cur.token !== wantToken) patch.token = wantToken;
                        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
                        // clipTemplate 一并带回：宿主预缓存后，剪藏时模板零 SW 查询
                        return JSON.stringify({ changed: Object.keys(patch).length > 0, clipTemplate: cur.clipTemplate || null });
                    })()`;
                    const r = await this.evalInSwAny(clip.electronId, expr);
                    if (!r.err) {
                        try {
                            const parsed = JSON.parse(String(r.value || "{}"));
                            // 无论有无自定义模板都记录（null = 用户未自定义 → 剪藏时直用默认模板）
                            clipTemplateCache.set(clip.electronId, parsed.clipTemplate ? String(parsed.clipTemplate) : CLIP_DEFAULT_TEMPLATE);
                        } catch {}
                        console.log("[browser-plugin] seed kernel settings ok (attempt", attempt + 1 + "):", String(r.value || ""));
                        return;
                    }
                    console.warn("[browser-plugin] seed attempt", attempt + 1, "err:", String(r.err).slice(0, 160));
                } else {
                    console.warn("[browser-plugin] seed attempt", attempt + 1, ": SiYuan 扩展未就绪");
                }
            } catch (e: any) {
                console.warn("[browser-plugin] seed attempt", attempt + 1, "exception:", String(e?.message || e).slice(0, 160));
            }
            await new Promise((res) => setTimeout(res, 3000));
        }
        console.warn("[browser-plugin] seed kernel settings: 10 轮重试全部失败（ip=" + ip + "）");
    }

    /** manager 级 isolated world 直调：为该 webview 取会话走 flat 通道 */
    async evalExtensionWorldAny(webview: IWebviewTag, electronId: string, expr: string): Promise<{ ok: boolean; value?: any; error?: string; contextId?: number }> {
        const s = await this.sessionFor(webview);
        return await s.evalInExtensionWorldFlat(electronId, expr);
    }

    /** 确保扩展自建世界存在（userScripts 注入前置），见 CsPageSession.ensureExtWorld */
    async ensureExtensionWorld(webview: IWebviewTag, ext: ICsExtInfo): Promise<void> {
        const s = await this.sessionFor(webview);
        return s.ensureExtWorld(ext);
    }
}

class CsPageSession {
    private seq = 0;
    private frameId: string | null = null;
    /** electronId → content 世界 contextId（跑内容脚本） */
    private contentWorlds = new Map<string, number>();
    /** electronId → 当前 popup 世界 contextId（每次打开面板新建） */
    private popupWorldByExt = new Map<string, number>();
    /** popup 世界 contextId → electronId（桥调用反查） */
    private popupCtxs = new Map<number, string>();
    /** 当前文档已执行过 CS 入口的扩展（导航后清空） */
    private ran = new Set<string>();
    private attached = false;
    private ctxToExt = new Map<number, string>();
    /** SW→CS 回程泵（electronId → 轮询状态）：routeSendMessage 派发后限时运行 */
    private swReplyPumps = new Map<string, { deadline: number; busy: boolean; timer: ReturnType<typeof setInterval> }>();
    /** 大消息分块缓冲：id → 分块数组（binding 通道挂大 payload，CS 切块过桥、此处拼装） */
    private bigMsgBuffers = new Map<string, { parts: (string | null)[]; received: number; total: number; ts: number }>();

    constructor(
        private wc: any,
        public pageUrl: string,
        private host: ICsRuntimeHost,
        private onDead: () => void
    ) {}

    get alive(): boolean {
        return this.attached && !this.wc.isDestroyed?.();
    }

    close(): void {
        for (const [eid, w] of this.swReplyPumps) {
            clearInterval(w.timer);
        }
        this.swReplyPumps.clear();
        if (this.attached) {
            try {
                this.wc.debugger.detach();
            } catch {}
            this.attached = false;
        }
    }

    private send(method: string, params: any = {}, timeoutMs = 15000, sessionId?: string): Promise<any> {
        return Promise.race([
            this.wc.debugger.sendCommand(method, params, sessionId),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP ${method} 超时`)), timeoutMs)),
        ]);
    }

    /** Node http(s) 代发内核请求（面板/内容世界的 mixed content 绕行）。
     *  用户配置的 ip scheme 可能与内核真实协议不符（如 http:// 配到 https 内核）——
     *  失败后自动交换协议重试一次。 */
    private async kernelFetchNode(
        url: string,
        method: string,
        headers: Record<string, string>,
        body?: string
    ): Promise<{ status: number; bodyText: string }> {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            return { status: 0, bodyText: "" };
        }
        const attempt = (scheme: string): Promise<{ status: number; bodyText: string }> =>
            new Promise((resolve) => {
                const req = (window as any).require;
                if (!req) { resolve({ status: 0, bodyText: "" }); return; }
                const lib = scheme === "https" ? req("https") : req("http");
                let settled = false;
                const done = (v: { status: number; bodyText: string }) => {
                    if (settled) return;
                    settled = true;
                    resolve(v);
                };
                try {
                    const rq = lib.request(
                        {
                            hostname: u.hostname,
                            port: u.port || (scheme === "https" ? 443 : 80),
                            path: u.pathname + u.search,
                            method,
                            headers,
                            // 思源内核是自签名证书 —— Node 默认拒绝，必须放宽
                            rejectUnauthorized: false,
                        },
                        (res: any) => {
                            let data = "";
                            res.on("data", (c: any) => { data += c; });
                            res.on("end", () => done({ status: res.statusCode || 0, bodyText: data }));
                            res.on("error", () => done({ status: 0, bodyText: "" }));
                        }
                    );
                    // 20s：route 内部等待须 < 桥超时 25s —— 内核慢响应在此转为
                    // status 0（CS 侧按请求失败处理），避免顶爆桥产生假超时
                    rq.setTimeout(20000, () => {
                        try { rq.destroy(); } catch (e) {}
                        done({ status: 0, bodyText: "" });
                    });
                    rq.on("error", () => done({ status: 0, bodyText: "" }));
                    if (body !== undefined) rq.write(body);
                    rq.end();
                } catch (e) {
                    done({ status: 0, bodyText: "" });
                }
            });
        const scheme0 = u.protocol.replace(":", "") || "http";
        const first = await attempt(scheme0);
        if (first.status === 0) {
            // 协议可能配反（http:// 配到 https 内核）→ 交换协议重试一次
            const alt = scheme0 === "http" ? "https" : "http";
            return await attempt(alt);
        }
        return first;
    }

    async start(): Promise<void> {
        try {
            this.wc.debugger.attach("1.3");
        } catch (e: any) {
            const msg = String(e?.message || e);
            if (!msg.includes("already attached")) throw new Error("debugger attach 失败: " + msg);
        }
        this.attached = true;
        this.wc.debugger.on("message", (_event: any, method: string, params: any) => {
            this.onCdpEvent(method, params);
        });
        this.wc.debugger.on("detach", () => {
            this.attached = false;
            this.onDead();
        });
        await this.send("Page.enable");
        await this.send("Runtime.enable");
        const tree: any = await this.send("Page.getFrameTree");
        // 注意返回结构是 {frameTree: {frame}}，不是 {frame}（取错层级 → frameId 恒 null → sync 静默跳过）
        this.frameId = tree?.frameTree?.frame?.id || tree?.frame?.id || null;
    }

    private onCdpEvent(method: string, params: any): void {
        if (method === "Page.frameNavigated" && params?.frame && !params.frame.parentId) {
            // 主框架导航：世界与执行标记全部作废，sync 时按新文档重建
            this.frameId = String(params.frame.id || this.frameId);
            this.contentWorlds.clear();
            this.popupWorldByExt.clear();
            this.popupCtxs.clear();
            this.ran.clear();
            this.ctxToExt.clear();
            return;
        }
        if (method === "Runtime.executionContextCreated") {
            // Electron 原生注入的扩展 CS 世界（空壳 chrome 死代码）静默化：
            // 其周期性 chrome.runtime.sendMessage 调用会持续刷
            // "Unchecked runtime.lastError: Could not establish connection"（用户可见噪音）
            const c = params?.context || {};
            const isIsolated = c.type === "isolated" || (c.auxData && c.auxData.type === "isolated");
            const cname = String(c.name || "");
            if (isIsolated
                && String(c.origin || "").indexOf("chrome-extension://") === 0
                && cname.indexOf(CS_WORLD_PREFIX) !== 0
                && cname.indexOf(POPUP_WORLD_PREFIX) !== 0) {
                void this.silenceNativeWorld(Number(c.id));
            }
            return;
        }
        if (method === "Runtime.bindingCalled" && params?.name === BRIDGE_NAME) {
            void this.onBridgeCall(Number(params.executionContextId), String(params.payload || "{}"));
        }
    }

    private silencedCtxs = new Set<number>();

    /** 原生世界消音：原生 isolated world 是死代码副本（消息路由断），其周期性
     *  chrome.runtime.sendMessage（MV3 Promise 风格）reject → unhandledrejection
     *  → DevTools 刷 "Could not establish connection"。
     *  注意：原生 chrome 属性是不可配置的 native accessor，defineProperty 装不上桩
     *  （实测）—— 只能加 unhandledrejection preventDefault（隔离世界全局私有，
     *  只消音本世界，不影响自建世界/面板世界的真实错误）。 */
    private async silenceNativeWorld(ctxId: number): Promise<void> {
        if (this.silencedCtxs.has(ctxId) || this.silencedCtxs.size > 200) return;
        this.silencedCtxs.add(ctxId);
        try {
            await this.send(
                "Runtime.evaluate",
                {
                    expression: `(function () {
                        try {
                            if (window.__sySilenced) return;
                            window.__sySilenced = true;
                            self.addEventListener("unhandledrejection", function (e) {
                                try {
                                    var msg = e && e.reason && (e.reason.message || String(e.reason)) || "";
                                    // Electron 原生世界三件套噪音：消息路由断（Receiving end）、
                                    // storage.sync 服务缺失（"sync" is not available in this
                                    // instance of Chrome —— Chromium 152 原生副本已非空壳，
                                    // 顶层读设置即抛）。均为死代码副本的功能性缺失，消音。
                                    if (msg.indexOf("Receiving end") >= 0
                                        || msg.indexOf("establish connection") >= 0
                                        || msg.indexOf("not available in this instance of Chrome") >= 0) {
                                        e.preventDefault();
                                    }
                                } catch (e2) {}
                            });
                        } catch (e) {}
                    })()`,
                    contextId: ctxId,
                    returnByValue: false,
                },
                5000
            );
        } catch {}
    }

    /** 确保当前文档里所有适用扩展都有可用世界并已执行 CS */
    async sync(): Promise<void> {
        if (!this.alive || !this.frameId) return;
        const exts = this.host.listNativeExts();
        for (const ext of exts) {
            try {
                await this.installExt(ext);
            } catch (e) {
                console.warn(`[browser-plugin] cs-runtime: "${ext.name}" 世界安装失败:`, e);
            }
        }
    }

    /**
     * 确保扩展的自建世界存在（不执行 content script）。
     * chrome.userScripts 适配（userscriptInjector.ts）用：油猴类扩展没有静态
     * content script，installExt 会跳过建世界 —— 宿主注入注册脚本前先经这里
     * 把世界（含 chrome.* 垫片与消息桥）建出来。
     */
    async ensureExtWorld(ext: ICsExtInfo): Promise<void> {
        if (!this.alive || !this.frameId) throw new Error("CDP 会话未就绪");
        if (this.contentWorlds.has(ext.electronId)) return;
        const r: any = await this.send("Page.createIsolatedWorld", {
            frameId: this.frameId,
            worldName: CS_WORLD_PREFIX + ext.electronId,
            grantUniversalAccess: true,
            allowCommandLineAPI: false,
        });
        const ctxId = r?.executionContextId;
        if (!ctxId) throw new Error("createIsolatedWorld 未返回 contextId");
        this.contentWorlds.set(ext.electronId, ctxId);
        await this.send("Runtime.addBinding", { name: BRIDGE_NAME, executionContextId: ctxId });
        const shim = buildShim(ext, this.host.messages(ext.path, ext.defaultLocale));
        const sr: any = await this.send("Runtime.evaluate", {
            expression: shim,
            contextId: ctxId,
            returnByValue: false,
        });
        if (sr?.exceptionDetails) {
            throw new Error(
                "垫片执行异常: " + String(sr.exceptionDetails?.exception?.description || sr.exceptionDetails?.text).slice(0, 200)
            );
        }
    }

    private async installExt(ext: ICsExtInfo): Promise<void> {
        if (this.contentWorlds.has(ext.electronId) && this.ran.has(ext.electronId)) return;
        // 全量接管：原生 manifest 的 content_scripts 已被 neutralizeNativeContentScripts
        // 清空（原生不再注入任何副本），所有 content script 都由本世界执行。
        // 时机折衷：原生 document_start 的脚本统一在 dom-ready 后执行 —— 对
        // Clip（idle）/Eruda（手动）无影响；若未来有依赖 start 时序的扩展再行适配。
        const groups = (ext.contentScripts || []).filter((cs) =>
            (cs.matches || []).some((p) => matchesUrlPattern(p, this.pageUrl))
        );
        if (groups.length === 0) return;

        let ctxId = this.contentWorlds.get(ext.electronId);
        if (!ctxId) {
            const r: any = await this.send("Page.createIsolatedWorld", {
                frameId: this.frameId,
                worldName: CS_WORLD_PREFIX + ext.electronId,
                grantUniversalAccess: true,
                allowCommandLineAPI: false,
            });
            ctxId = r?.executionContextId;
            if (!ctxId) throw new Error("createIsolatedWorld 未返回 contextId");
            this.contentWorlds.set(ext.electronId, ctxId);
            await this.send("Runtime.addBinding", { name: BRIDGE_NAME, executionContextId: ctxId });
            const shim = buildShim(ext, this.host.messages(ext.path, ext.defaultLocale));
            const sr: any = await this.send("Runtime.evaluate", {
                expression: shim,
                contextId: ctxId,
                returnByValue: false,
            });
            if (sr?.exceptionDetails) {
                throw new Error(
                    "垫片执行异常: " + String(sr.exceptionDetails?.exception?.description || sr.exceptionDetails?.text).slice(0, 200)
                );
            }
        }
        if (this.ran.has(ext.electronId)) return;
        // CSS 注入：原生注入渠道已移除，manifest 声明的 css 由这里补上
        //（style 标签进文档，世界与页面共享 DOM；同文档只注一次，随 ran 守卫幂等）
        for (const cs of groups) {
            for (const f of cs.css || []) {
                try {
                    const css = this.host.readFile(ext.path, f);
                    await this.send("Runtime.evaluate", {
                        expression: `(function(){var s=document.createElement("style");s.setAttribute("data-sy-ext-css",${JSON.stringify(ext.electronId)});s.textContent=${JSON.stringify(css)};(document.head||document.documentElement).appendChild(s);})()`,
                        contextId: ctxId,
                        returnByValue: false,
                    });
                } catch (e: any) {
                    console.warn(`[browser-plugin] cs-runtime: "${ext.name}" CSS 注入失败 ${f}:`, e?.message || e);
                }
            }
        }
        // 执行内容脚本入口（源码来自磁盘；世界是我们建的，不存在重声明冲突）
        const errors: string[] = [];
        for (const cs of groups) {
            for (const f of cs.js || []) {
                try {
                    const src = this.host.readFile(ext.path, f);
                    const r: any = await this.send("Runtime.evaluate", {
                        expression: src,
                        contextId: ctxId,
                        returnByValue: false,
                    });
                    if (r?.exceptionDetails) {
                        errors.push(
                            `${f}: ` +
                                String(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "unknown")
                                    .split("\n")[0]
                                    .slice(0, 160)
                        );
                    }
                } catch (e: any) {
                    errors.push(`${f}: ${String(e?.message || e).slice(0, 160)}`);
                }
            }
        }
        this.ran.add(ext.electronId);
        if (errors.length) {
            console.warn(`[browser-plugin] cs-runtime: "${ext.name}" 内容脚本执行异常: ${JSON.stringify(errors)}`);
        } else {
            console.log(`[browser-plugin] cs-runtime: "${ext.name}" 内容脚本已在自建世界运行 (${ext.electronId})`);
        }
        // DOMContentLoaded 兜底：重放注入时文档已就绪，DOMContentLoaded 不会再触发，
        // 扩展在它的回调里注册的 onMessage 监听器（实测 Clip eventDispatcher）会永久
        // 错过 → 面板发送/消息全链静默无反应。每世界补发一次。
        try {
            await this.send(
                "Runtime.evaluate",
                {
                    expression: `(function () {
                        if (document.readyState === "loading") return "loading";
                        if (self.__syDomReadyDispatched) return "already";
                        self.__syDomReadyDispatched = true;
                        try { document.dispatchEvent(new Event("DOMContentLoaded")); } catch (e) {}
                        return "dispatched";
                    })()`,
                    contextId: ctxId,
                    returnByValue: false,
                },
                8000
            );
        } catch {}
    }

    // ===== CS → 宿主 桥请求 =====

    private async onBridgeCall(ctxId: number, payload: string): Promise<void> {
        let req: any;
        try {
            req = JSON.parse(payload);
        } catch {
            return;
        }
        let electronId = this.ctxToExt.get(ctxId);
        if (!electronId) {
            electronId = this.popupCtxs.get(ctxId) || null;
            if (!electronId) {
                for (const [eid, cid] of this.contentWorlds) {
                    if (cid === ctxId) {
                        electronId = eid;
                        break;
                    }
                }
            }
            if (electronId) this.ctxToExt.set(ctxId, electronId);
        }
        const ext = this.host.listNativeExts().find((e) => e.electronId === electronId);
        const result = ext
            ? await this.route(ext, req).catch((e) => ({ err: String(e?.message || e) }))
            : { err: "unknown context" };
        const replyExpr = `window.__syExtHostResolve && window.__syExtHostResolve(${JSON.stringify(
            JSON.stringify({ reqId: req.reqId, ...result })
        )})`;
        try {
            await this.send(
                "Runtime.evaluate",
                {
                    expression: replyExpr,
                    contextId: ctxId,
                    returnByValue: false,
                },
                10000
            );
        } catch {
            // 回写失败（导航竞态/上下文失效）：route 可能已实际执行成功（剪藏场景），
            // 丢失响应会让 CS 端 pending 挂到 bridge timeout。按世界身份重找新
            // contextId 补写一次；世界已销毁时补写自然落空（旧 pending 随堆销毁，无害）。
            if (!electronId) return;
            const retryCtx = this.contentWorlds.get(electronId)
                ?? [...this.popupCtxs.entries()].find(([, eid]) => eid === electronId)?.[0];
            if (retryCtx && retryCtx !== ctxId) {
                try {
                    await this.send(
                        "Runtime.evaluate",
                        { expression: replyExpr, contextId: retryCtx, returnByValue: false },
                        10000
                    );
                } catch {}
            }
        }
    }

    private async route(ext: ICsExtInfo, req: any): Promise<{ data?: any; err?: string }> {
        const args = req.args || {};
        const msg = args.msg;
        if (msg && typeof msg === "object" && msg.func) {
            // ★ 原生通讯链路：SiYuan Clip 的剪藏/校验由宿主直连内核执行 —— 主窗口
            //   与内核同源（https://127.0.0.1:<port>/stage/），FormData/fetch 原生
            //   可用，完全绕开 SW handler 与 SW→CS 回程泵。完成 tip 由宿主经
            //   dispatchToContentWorld 直达 content 世界（单次 evaluate，无 outbox
            //   无轮询），处理结束立即提醒；也不再受 SW 空闲回收影响（keepalive
            //   仅为其它经 SW 的扩展调用保留）。
            if (msg.func === "upload-copy") {
                await this.handleUploadCopyNatively(ext, msg.data || {});
                return { data: null };
            }
            if (msg.func === "check-kernel") {
                return { data: await this.handleCheckKernelNatively(msg.data || {}) };
            }
        }
        if (req.type === "storage") {
            const op = String(args.op || "get");
            // sync/session 代理到 local（与扩展页垫片 83a6d9b 同策略）
            const payloadJson = JSON.stringify(args.payload === undefined ? null : args.payload);
            const exprs: Record<string, string> = {
                get: `(async () => JSON.stringify(await chrome.storage.local.get(${payloadJson})))()`,
                set: `(async () => { await chrome.storage.local.set(${payloadJson}); return "ok"; })()`,
                remove: `(async () => { await chrome.storage.local.remove(${payloadJson}); return "ok"; })()`,
                clear: `(async () => { await chrome.storage.local.clear(); return "ok"; })()`,
            };
            const expr = exprs[op];
            if (!expr) return { err: "unknown storage op: " + op };
            const r = await this.evalInSw(ext, expr);
            if (r.err) return { err: r.err };
            if (op === "get") {
                try {
                    return { data: JSON.parse(String(r.value)) };
                } catch {
                    return { data: {} };
                }
            }
            return { data: undefined };
        }
        if (req.type === "kernelfetch") {
            // 面板/内容世界的内核请求代理（mixed content 绕行）：Node http 代发
            const url = String(args.url || "");
            const method = String(args.method || "GET").toUpperCase();
            const headers = (args.headers && typeof args.headers === "object") ? args.headers : {};
            const body = args.body === undefined || args.body === null ? undefined : String(args.body);
            const r = await this.kernelFetchNode(url, method, headers, body);
            return { data: r };
        }
        if (req.type === "bigmsg-chunk") {
            // 大消息分块接收：binding 通道挂大 payload，CS 侧把大 JSON 切 <400KB 块
            // 逐次过桥，这里按 id 拼装进内存缓冲，sendmessage-big 时取走拼装。
            // 缓冲 5 分钟自动回收（发送方崩溃/放弃时防泄漏）。
            const id = String(args.id || "");
            const total = Number(args.total || 0);
            if (!id || !(total > 0)) return { err: "bad bigmsg chunk" };
            let buf = this.bigMsgBuffers.get(id);
            if (!buf) {
                buf = { parts: new Array(total).fill(null), received: 0, total, ts: Date.now() };
                this.bigMsgBuffers.set(id, buf);
                const now = Date.now();
                for (const [k, b] of this.bigMsgBuffers) {
                    if (now - b.ts > 5 * 60_000) this.bigMsgBuffers.delete(k);
                }
            }
            const idx = Number(args.idx || 0);
            if (idx >= 0 && idx < buf.total && !buf.parts[idx]) {
                buf.parts[idx] = String(args.data || "");
                buf.received++;
            }
            return { data: { received: buf.received, total: buf.total } };
        }
        if (req.type === "sendmessage-big") {
            // 大消息：从内存缓冲拼装（CS 经 bigmsg-chunk 分块送达）→ 走常规路由
            const buf = this.bigMsgBuffers.get(String(args.id || ""));
            if (!buf) return { err: "big message buffer missing" };
            this.bigMsgBuffers.delete(String(args.id || ""));
            let bigMsg: any = null;
            try {
                bigMsg = JSON.parse(buf.parts.map((p) => p ?? "").join(""));
            } catch {
                return { err: "big message assemble failed" };
            }
            return await this.routeSendMessage(ext, { msg: bigMsg, senderUrl: String(args.senderUrl || "") });
        }
        if (req.type === "sendmessage") {
            return await this.routeSendMessage(ext, args);
        }
        if (req.type === "portmessage") {
            // portmessage：扩展用长连接端口取状态（AdGuard Messenger 等），
            // 走 SW 垫片 v5 的 onConnect 端口语义（建连/复用 + outbox 回包）
            return await this.routePortMessage(ext, args);
        }
        if (req.type === "portpoll") {
            // 端口常驻泵拉取：世界侧定期取走滞留回包（见 portPoll 注释）
            return await this.portPoll(ext, args);
        }
        if (req.type === "tabevent") {
            // popup 世界 tabs.query 时同步喂 SW 的 tab 注册表
            // （AdGuard 的 tabsApi 靠 tabs 事件建 tabContext，Electron 下事件缺失）
            return await this.feedTabEventToSw(ext, args);
        }
        if (req.type === "tabs-sendmessage") {
            // popup 世界 → content 世界的 onMessage 监听器（SW↔CS 路由缺失的替代）
            return await this.dispatchToContentWorld(ext, args);
        }
        if (req.type === "usdata") {
            // 新标签页扩展数据适配：topSites/bookmarks/history 查询由宿主
            // 用插件自己的历史/书签库代答（Electron 无这些 API）
            if (!this.host.userData) return { err: "userData provider missing" };
            try {
                const data = await this.host.userData(String(args.kind || ""), args);
                return { data: data === undefined ? null : data };
            } catch (e: any) {
                return { err: String(e?.message || e) };
            }
        }
        return { err: "unknown bridge type: " + req.type };
    }

    /**
     * SW→CS 回程（chrome.tabs.sendMessage）监听窗口：SW 垫片 v13 把回程请求
     * 写入 __syTabsOutbox，这里在窗口期内轮询取走 → 派发到本页 content 世界
     * → 写回响应。限时启动（每次 CS→SW 派发后续期）避免常驻轮询把 MV3 SW
     * 钉在活跃态；本页没有该扩展的 content 世界时不启动（无接收方）。
     */
    private noteSwReplyWindow(electronId: string): void {
        if (!this.contentWorlds.has(electronId)) return;
        const w = this.swReplyPumps.get(electronId);
        if (w) {
            w.deadline = Date.now() + SW_REPLY_WINDOW_MS;
            return;
        }
        const entry: { deadline: number; busy: boolean; failCount: number; timer: ReturnType<typeof setInterval> } = {
            deadline: Date.now() + SW_REPLY_WINDOW_MS,
            busy: false,
            failCount: 0,
            timer: null as any,
        };
        entry.timer = setInterval(() => void this.pumpSwReplies(electronId, entry), 600);
        this.swReplyPumps.set(electronId, entry);
    }

    private stopSwReplyPump(electronId: string, entry: { timer: ReturnType<typeof setInterval> }): void {
        clearInterval(entry.timer);
        this.swReplyPumps.delete(electronId);
    }

    private async pumpSwReplies(electronId: string, entry: { deadline: number; busy: boolean; timer: ReturnType<typeof setInterval> }): Promise<void> {
        if (Date.now() > entry.deadline || !this.alive || !this.contentWorlds.has(electronId)) {
            this.stopSwReplyPump(electronId, entry);
            return;
        }
        if (entry.busy) return;
        entry.busy = true;
        try {
            const sender: FlatCommandSender = (method, params, sessionId) => Promise.race([
                this.wc.debugger.sendCommand(method, params, sessionId),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 8000)),
            ]);
            let r = await evalInSwFlatCached(sender, electronId, SW_TABS_DRAIN_EXPR);
            if (r.err === SW_FLAT_UNAVAILABLE) {
                // 缓存缺失/失效：SW 休眠/重启等瞬时态 —— 不立即停泵（tip 可能就在
                // 下一次 tick 的 outbox 里，误停会让完成提示滞留到下次剪藏才补显），
                // 连续失败 20 次（≈12s）才判定通道确实不可用
                entry.failCount++;
                if (entry.failCount >= 20) {
                    this.stopSwReplyPump(electronId, entry);
                    return;
                }
                const found = await findSwFlatSession(sender, electronId);
                if (!found) return;
                r = await evalInSwFlatCached(sender, electronId, SW_TABS_DRAIN_EXPR);
                if (r.err) return;
            } else if (r.err) {
                entry.failCount++;
                if (entry.failCount >= 20) {
                    this.stopSwReplyPump(electronId, entry);
                }
                return;
            }
            entry.failCount = 0;
            let reqs: any[] = [];
            try { reqs = JSON.parse(String(r.value ?? "[]")) || []; } catch {}
            if (reqs.length > 0) {
                // SW 仍在产生回程消息（剪藏大流程可持续超过单窗口期）→ 顺延监听窗口，
                // 保证 tip 流转全程有泵接驳（卡"剪藏中"的根源之一是窗口先于流程结束）
                entry.deadline = Date.now() + SW_REPLY_WINDOW_MS;
            }
            for (const req of reqs) {
                if (!req || typeof req.id !== "string") continue;
                const out = await this.dispatchToContentWorld({ electronId } as ICsExtInfo, {
                    msg: req.msg,
                    tabId: typeof req.tabId === "number" ? req.tabId : undefined,
                    senderUrl: `chrome-extension://${electronId}/background.js`,
                });
                // 写回响应（无接收方/异常 → undefined，对齐 Chrome lastError 语义）
                const respJson = JSON.stringify(out.data === undefined ? null : out.data);
                const rid = JSON.stringify(req.id);
                await evalInSwFlatCached(
                    sender,
                    electronId,
                    `(() => { const p = self.__syTabsPending && self.__syTabsPending[${rid}]; if (p) { delete self.__syTabsPending[${rid}]; p(${JSON.stringify(respJson)}); } return 1; })()`
                ).catch(() => null);
            }
        } catch {
            // 会话失效/调试通道异常 → 停泵（下次 CS→SW 派发会重新开窗）
            this.stopSwReplyPump(electronId, entry);
        } finally {
            entry.busy = false;
        }
    }

    /** tip 直达派发：宿主 → content 世界的 onMessage 监听器（单次 evaluate） */
    private async dispatchTip(ext: ICsExtInfo, payload: Record<string, any>): Promise<void> {
        try {
            console.log(`[browser-plugin] dispatchTip begin func=${payload.func} msg=${String(payload.msg).slice(0, 40)}`);
            await this.dispatchToContentWorld(ext, {
                msg: payload,
                tabId: typeof payload.tabId === "number" ? payload.tabId : undefined,
                senderUrl: `chrome-extension://${ext.electronId}/background.js`,
            });
            console.log("[browser-plugin] dispatchTip done");
        } catch (e: any) {
            console.warn("[browser-plugin] dispatchTip ERR:", String(e?.message || e).slice(0, 120));
        }
    }

    /** ★ 原生通讯链路：SiYuan Clip 的剪藏由宿主直连内核执行（主窗口与内核同源，
     *  FormData/fetch 原生可用），完全绕开 SW handler 与 SW→CS 回程泵 —— 完成 tip
     *  由宿主直达 content 世界（dispatchToContentWorld 单次 evaluate），处理结束
     *  立即提醒，不再受 SW 空闲回收影响（keepalive 仅为其它经 SW 的扩展调用保留）。
     *  语义对齐 Clip background.js 的 handleUploadCopy/handleArticleClip：
     *  /api/extension/copy → 模板组装 →（数据库模板 | createDocWithMd）→
     *  数据库归属 → tip_clip_ok；图片转换兜底 fire-and-forget。 */
    private async handleUploadCopyNatively(ext: ICsExtInfo, data: Record<string, any>): Promise<void> {
        const nativeT0 = Date.now();
        const nativeLog = (step: string) => console.log(`[browser-plugin] native-clip [${Date.now() - nativeT0}ms] ${step}`);
        nativeLog("start, dom=" + String(data.dom || "").length + "B files=" + Object.keys(data.files || {}).length);
        const tip = String(data.tip || "tip");
        const sendTipKey = (key: string) => this.dispatchTip(ext, { func: "tipKey", msg: key, tip, tabId: data.tabId });
        const sendTipText = (text: string) => this.dispatchTip(ext, { func: "tip", msg: text, tip, tabId: data.tabId });
        try {
            // 1. /api/extension/copy（lute 转 Markdown + assets 资源下载，主耗时所在）
            const form = new FormData();
            form.append("dom", String(data.dom || ""));
            for (const key of Object.keys(data.files || {})) {
                const f = data.files[key];
                form.append(key, await fetch(String(f.data)).then((r) => r.blob()));
            }
            form.append("notebook", String(data.notebook || ""));
            form.append("href", String(data.href || ""));
            form.append("tags", String(data.tags || ""));
            form.append("clipType", String(data.type || "article"));
            form.append("assets", String(data.assets ?? false));
            const copyResp = await fetch("/api/extension/copy", { method: "POST", body: form });
            const copyResult: any = await copyResp.json();
            nativeLog("copy done, code=" + copyResult.code);
            if (copyResult.code < 0) {
                sendTipText(copyResult.msg || "copy failed");
                return;
            }
            const md = String(copyResult.data?.md || "");
            const withMath = copyResult.data?.withMath;

            // 2. 模板组装（★ 零阻塞：模板只从模块级缓存/默认取——SW storage 读取全部
            //    后台化（probe 阻塞查询实测会挂死 native 流程）。seed 启动时预填缓存；
            //    用户中途改模板经后台刷新在下次剪藏生效）
            let title = String(data.title || "") || "Untitled";
            title = title.replace(/[\\/]/g, "／") || "Untitled";
            let clipTemplate = clipTemplateCache.get(ext.electronId) || CLIP_DEFAULT_TEMPLATE;
            this.evalInSw(ext.electronId, `(async () => JSON.stringify(await chrome.storage.local.get(["clipTemplate"])))()`).then((rr) => {
                if (rr && !rr.err) {
                    try {
                        const parsed = JSON.parse(String(rr.value || "{}"));
                        if (parsed.clipTemplate) clipTemplateCache.set(ext.electronId, String(parsed.clipTemplate));
                        else clipTemplateCache.set(ext.electronId, CLIP_DEFAULT_TEMPLATE);
                    } catch {}
                }
            }).catch(() => {});
            nativeLog("template ready, len=" + clipTemplate.length);
            const href = String(data.href || "");
            let urlDecoded = href;
            try { urlDecoded = decodeURIComponent(href); } catch {}
            const tplData = {
                title,
                siteName: String(data.siteName || ""),
                excerpt: formatClipExcerpt(String(data.excerpt || "")),
                url: href,
                urlDecoded,
                date: new Date().toISOString().slice(0, 10),
                time: new Date().toTimeString().slice(0, 5),
                tags: String(data.tags || ""),
                content: md,
            };
            let markdown: string;
            try {
                markdown = renderClipTemplate(clipTemplate, tplData);
            } catch {
                markdown = getDefaultClipMarkdown({ ok: true, dom: "", files: {}, title: tplData.title, siteName: tplData.siteName, excerpt: tplData.excerpt, href, fetchFileErr: false }, md);
            }

            // 3. 保存路径（search 直接拼接；template 走 renderSprig）
            let parentPath = String(data.savePathTemplate || "/");
            if (String(data.savePathMode) === "template") {
                const sprig: any = await fetchSyncPost("/api/template/renderSprig", { template: parentPath || "/" });
                if (sprig?.code !== 0 || typeof sprig?.data !== "string") {
                    if (sprig?.msg) sendTipText(sprig.msg); else sendTipKey("tip_siyuan_kernel_unavailable");
                    return;
                }
                parentPath = String(sprig.data);
            }
            let path = parentPath.split("\\").join("/").replace(/\/{2,}/g, "/");
            if (!path.startsWith("/")) path = "/" + path;
            if (path.length > 1) path = path.replace(/\/+$/, "");
            path = (path === "/" ? "" : path) + "/" + title;
            nativeLog("path ready: " + path);

            // 4. 创建文档（数据库模板入口 | 常规 createDocWithMd）
            let docId = "";
            if (data.selectedDatabaseTemplateID) {
                const r: any = await fetchSyncPost("/api/av/createAttributeViewItemWithMarkdown", {
                    avID: data.selectedDatabaseTemplateID,
                    blockID: data.selectedDatabaseBlockID || "",
                    viewID: data.selectedDatabaseViewID || "",
                    templateID: data.selectedDatabaseTemplateID,
                    title,
                    markdown,
                    tags: String(data.tags || ""),
                    withMath,
                    clippingHref: href,
                    listDocTree: data.listDocTree ?? false,
                });
                if (r?.code !== 0) { sendTipText(r?.msg || "database create failed"); return; }
                docId = String(r.data?.blockID || "");
            } else {
                const r: any = await fetchSyncPost("/api/filetree/createDocWithMd", {
                    notebook: String(data.notebook || ""),
                    parentID: String(data.parentDoc || ""),
                    tags: String(data.tags || ""),
                    path,
                    markdown,
                    withMath,
                    clippingHref: href,
                    listDocTree: data.listDocTree ?? false,
                });
                if (r?.code !== 0) {
                    // 对齐 Clip 语义：有 msg 显示文案；code===1 → tip_save_path_miss
                    if (r?.msg) sendTipText(r.msg); else sendTipKey(r?.code === 1 ? "tip_save_path_miss" : "tip_siyuan_kernel_unavailable");
                    return;
                }
                docId = String(r.data || "");
            }
            if (!docId) { sendTipKey("tip_siyuan_kernel_unavailable"); return; }

            // 5. 数据库归属（flushTransaction 后 addAttributeViewBlocks）
            if (!data.selectedDatabaseTemplateID && data.selectedDatabaseID) {
                try {
                    await fetchSyncPost("/api/sqlite/flushTransaction", {});
                    await fetchSyncPost("/api/av/addAttributeViewBlocks", {
                        avID: data.selectedDatabaseID,
                        srcs: [{ id: docId, isDetached: false }],
                    });
                } catch {}
            }

            // 6. 完成 tip（宿主直达，立即提醒）
            nativeLog("db done → dispatching tip_clip_ok");
            await sendTipKey("tip_clip_ok");
            nativeLog("tip_clip_ok dispatched");

            // 7. 图片抓取失败 → 网络图片转本地兜底（fire-and-forget）
            if (data.fetchFileErr) {
                fetchSyncPost("/api/format/netImg2LocalAssets", { id: docId, url: href }).catch(() => {});
            }
        } catch (e: any) {
            nativeLog("EXCEPTION after copy: " + String(e?.message || e).slice(0, 150));
            try { await sendTipText(String(e?.message || e).slice(0, 120)); } catch (e2) { nativeLog("error tip dispatch failed: " + String(e2?.message || e2).slice(0, 100)); }
        }
    }

    /** ★ 原生通讯链路：check-kernel 由宿主直连内核校验（token/notebook/笔记本状态） */
    private async handleCheckKernelNatively(data: Record<string, any>): Promise<{ ok?: boolean; error?: string }> {
        try {
            const token = String(data.token || "");
            const notebook = String(data.notebook || "");
            if (!token || !notebook) return { ok: false, error: "tip_save_path_miss" };
            const r: any = await fetchSyncPost("/api/notebook/lsNotebooks", {});
            const notebooks = r?.data?.notebooks || [];
            if (!Array.isArray(notebooks) || !notebooks.some((n: any) => n.id === notebook && !n.closed)) {
                return { ok: false, error: "tip_save_path_miss" };
            }
            return { ok: true };
        } catch {
            return { ok: false, error: "tip_siyuan_kernel_unavailable" };
        }
    }

    /**
     * CS→SW 消息：宿主经 CDP 直调 SW 垫片 v4 收集的 onMessage handlers。
     * 不走 storage.onChanged 中转 —— 实测 Electron SW 里该事件不可靠（自写不触发）。
     * 语义对齐 Chrome：handler 返回 true = 异步 sendResponse；否则首个非 undefined
     * 同步返回值即响应；无处理器/超时按 undefined 回调。
     */
    private async routeSendMessage(ext: ICsExtInfo, args: any): Promise<{ data?: any; err?: string }> {
        // 消息派发后 SW 侧可能经 tabs.sendMessage 回程（剪藏 tip/结果等）—— 开监听窗口
        this.noteSwReplyWindow(ext.electronId);
        const msgJson = JSON.stringify(args.msg === undefined ? null : args.msg);
        const sendSenderObj: any = { id: ext.electronId, url: String(args.senderUrl || "").slice(0, 300) };
        if (args.tabId !== null && args.tabId !== undefined) {
            sendSenderObj.tab = { id: Number(args.tabId), url: sendSenderObj.url };
        }
        const senderJson = JSON.stringify(sendSenderObj);
        const expr = `(async () => {
            const fns = self.__syOnMessageHandlers || [];
            if (!fns.length) return JSON.stringify({ __noHandlers: true });
            // ★ SW keepalive：扩展 handler 常为 fire-and-forget（实测 SiYuan Clip
            //   onMessage 里 void handleUploadCopy(...)）——事件回调同步返回后 SW
            //   开始 30s 空闲倒计时，多图剪藏处理超 30s 会被回收中断（文档未建完、
            //   完成_tip 永不发出，用户挂在"剪藏中"很久）。每 20s 一次 runtime API
            //   心跳重置空闲计时，窗口 4 分钟，到期自动停。
            if (!self.__syKeepAliveUntil || Date.now() > self.__syKeepAliveUntil) {
                self.__syKeepAliveUntil = Date.now() + 240000;
                if (!self.__syKeepAliveTimer) {
                    self.__syKeepAliveTimer = setInterval(function () {
                        if (Date.now() > (self.__syKeepAliveUntil || 0)) {
                            clearInterval(self.__syKeepAliveTimer);
                            self.__syKeepAliveTimer = null;
                            return;
                        }
                        try { chrome.runtime.getPlatformInfo(function () {}); } catch (e) {}
                    }, 20000);
                }
            }
            return await new Promise((resolve) => {
                let done = false;
                const finish = (v) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(JSON.stringify(v === undefined ? null : v));
                };
                // 20s：宿主 route 内部等待须 < 桥超时 25s（sendmessage/big 的
                // handler 挂起兜底；剪藏大流程的进度走 SW→CS 回程 tip，不依赖此响应）
                const timer = setTimeout(() => finish(null), 20000);
                let asyncWait = false;
                const sendResponse = (resp) => finish(resp);
                // handler 返回 Promise（async 函数）→ 等其 resolve 作为响应（此前直接丢弃 → 应用收到 undefined 而崩）
                const useValue = (v) => { if (v !== undefined) finish(v); };
                for (const fn of fns) {
                    try {
                        // __syNormalizeMsg：垫片统一消息归一（TM loadTree referrer 等，
                        // 见 extensionHost 垫片 0b 节）
                        const r = fn(self.__syNormalizeMsg ? self.__syNormalizeMsg(${msgJson}) : ${msgJson}, ${senderJson}, sendResponse);
                        if (r === true) {
                            asyncWait = true;
                        } else if (r !== undefined && r !== false) {
                            // r===false 是 Chrome 语义的"我不回包"（真 Chrome 下回包
                            // 只能经 sendResponse），此前被当成回包值送达（实测 TM
                            // 门禁拒绝 loadTree 返回 false → 应用收到布尔 false 走
                            // fail 分支）—— 改为忽略，与真 Chrome 对齐
                            if (typeof r.then === "function") {
                                asyncWait = true;
                                // async handler resolve undefined（fire-and-forget 型，
                                // 如 Clip eventDispatcher 处理完 tip 直接 return）→
                                // 必须立即 finish，否则挂到 20s 兜底（完成提示延迟的真凶）
                                r.then((v) => { if (v === undefined) finish(undefined); else useValue(v); }, () => finish(undefined));
                            } else {
                                finish(r);
                                break;
                            }
                        }
                    } catch (e) {}
                }
                if (!asyncWait && !done) finish(undefined);
            });
        })()`;
        const r = await this.evalInSw(ext, expr);
        if (r.err) return { err: r.err };
        try {
            let parsed = JSON.parse(String(r.value));
            // SW 刚被 loadExtension 唤醒时 app 尚在初始化（AdGuard 过滤器加载 5-10s），
            // SW 冷启动期：background 顶层 addListener 尚未执行（handlers 数组为空）
            // → __noHandlers 重试（8 轮 × 2s ≈ 16s，覆盖扩展 background 的启动时长；
            // 须 < 桥超时 25s）。重试耗尽仍空 = 真实故障（垫片/handler 注册异常）。
            let tries = 0;
            while (parsed && parsed.__noHandlers && tries < 8) {
                tries++;
                console.warn("[browser-plugin] SW handlers 未就绪，重试", tries + "/8");
                await new Promise((res) => setTimeout(res, 2000));
                const r2 = await this.evalInSw(ext, expr);
                if (r2.err) return { err: r2.err };
                parsed = JSON.parse(String(r2.value));
            }
            if (parsed && parsed.__noHandlers) {
                // 重试耗尽仍无 handler：真实故障态。返回 err（调用方 Uncaught 可见），
                // 此前的静默降级会让 fire-and-forget 剪藏无声失败。
                console.warn("[browser-plugin] SW handlers 重试耗尽仍为空，func:",
                    (() => { try { return JSON.parse(String(args.msg === undefined ? "null" : args.msg))?.func || "?"; } catch { return "?"; } })());
                return { err: "扩展 SW 无 onMessage 处理器（重试 8 轮仍为空）" };
            }
            return { data: parsed === null ? undefined : parsed };
        } catch {
            return { data: undefined };
        }
    }

    /**
     * popup 世界 port 消息 → SW onConnect 端口语义（SW 垫片 v5）。
     * 首条消息建连：构造 port 对象派发给 __syOnConnectFns（扩展 handler 同步
     * 注册 port.onMessage listeners）；随后 dispatch 消息。回包（handler 异步
     * port.postMessage 进 outbox）由宿主侧分次小求值轮询取走 —— 单次求值内
     * 轮询会饿死慢回包（实测 TM tabInfo 要跨 storage 异步读，冷启动 >10s，
     * 10s 内轮询放弃后回包滞留 outbox，引导握手全饿死 → 面板"no access"）。
     * 宿主轮询每次求值独立 <12s，总窗口 24s；同端口滞留的旧回包一并取走
     * （端口消息按序到达，扩展按 messageId 配对，语义无损）。同一 portId
     * 复用端口，与真 Chrome 的 connect → postMessage 往返语义对齐。
     */
    private async routePortMessage(ext: ICsExtInfo, args: any): Promise<{ data?: any; err?: string }> {
        const portId = String(args.portId || "p" + Date.now().toString(36));
        const portName = String(args.portName || "");
        const msgJson = JSON.stringify(args.msg === undefined ? null : args.msg);
        // 内容世界的连接带 tab 归属（真 Chrome sender.tab 语义，TM 靠它把
        // bootstrap 连接归属到页签）；popup 世界无 tab。
        const senderObj: any = { id: ext.electronId, url: String(args.senderUrl || "").slice(0, 300) };
        if (args.tabId !== null && args.tabId !== undefined) {
            senderObj.tab = { id: Number(args.tabId), url: senderObj.url };
        }
        const senderJson = JSON.stringify(senderObj);
        const pidJson = JSON.stringify(portId);
        const expr = `(async () => {
            try {
                self.__syPorts = self.__syPorts || {};
                self.__syPortOutbox = self.__syPortOutbox || {};
                var outbox = self.__syPortOutbox[${pidJson}];
                var listeners = null;
                var created = false;
                var port = self.__syPorts[${pidJson}];
                if (!port) {
                    var fns = self.__syOnConnectFns || [];
                    if (!fns.length) return JSON.stringify({ __noConnectHandlers: true });
                    listeners = [];
                    outbox = [];
                    self.__syPortOutbox[${pidJson}] = outbox;
                    port = {
                        name: ${JSON.stringify(portName)},
                        sender: ${senderJson},
                        error: null,
                        onMessage: {
                            addListener: function (fn) { if (typeof fn === "function") listeners.push(fn); },
                            removeListener: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
                            hasListener: function (fn) { return listeners.indexOf(fn) >= 0; },
                        },
                        onDisconnect: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
                        postMessage: function (msg) { outbox.push(msg === undefined ? null : msg); },
                        disconnect: function () { delete self.__syPorts[${pidJson}]; },
                    };
                    self.__syPorts[${pidJson}] = port;
                    for (var i = 0; i < fns.length; i++) { try { fns[i](port); } catch (e) {} }
                    created = true;
                    if (!listeners.length) return JSON.stringify({ __noPortListeners: true });
                } else {
                    // 复用端口：从 port 对象恢复 listeners（垫片闭包不可达，存 port 上）
                    listeners = port.__syListeners || [];
                }
                if (!port.__syListeners) port.__syListeners = listeners;
                // __syNormalizeMsg：垫片统一消息归一（见 extensionHost 垫片 0b 节）
                var m = self.__syNormalizeMsg ? self.__syNormalizeMsg(${msgJson}) : ${msgJson};
                var ls = listeners.slice();
                for (var j = 0; j < ls.length; j++) { try { ls[j](m, port); } catch (e) {} }
                return JSON.stringify({ dispatched: true, created: created });
            } catch (e) {
                return JSON.stringify({ __portErr: String(e && e.message || e).slice(0, 200) });
            }
        })()`;
        const r = await this.evalInSw(ext, expr);
        if (r.err) return { err: r.err };
        try {
            let parsed = JSON.parse(String(r.value));
            // SW 唤醒后 app 初始化窗口期：onConnect handler 可能尚未注册 → 重试几轮
            let tries = 0;
            while (parsed && (parsed.__noConnectHandlers || parsed.__noPortListeners) && tries < 4) {
                tries++;
                await new Promise((res) => setTimeout(res, 1500));
                const r2 = await this.evalInSw(ext, expr);
                if (r2.err) return { err: r2.err };
                parsed = JSON.parse(String(r2.value));
            }
            if (parsed && parsed.__noConnectHandlers) return { err: "扩展 SW 无 onConnect 处理器（垫片 v5 未生效？）" };
            if (parsed && parsed.__noPortListeners) return { err: "扩展 SW onConnect 处理器未注册 port.onMessage 监听" };
            if (parsed && parsed.__portErr) return { err: "port 路由异常: " + parsed.__portErr };
        } catch {
            return { data: undefined };
        }
        // 回包轮询：宿主侧分次小求值（每次 <12s），总窗口 24s
        const pollExpr = `(function () {
            try {
                var ob = self.__syPortOutbox && self.__syPortOutbox[${pidJson}];
                if (!ob || !ob.length) return "[]";
                var arr = ob.slice();
                ob.length = 0;
                return JSON.stringify(arr);
            } catch (e) { return "[]"; }
        })()`;
        const deadline = Date.now() + 24000;
        while (Date.now() < deadline) {
            await new Promise((res) => setTimeout(res, 400));
            let pr: { value?: any; err?: string };
            try {
                pr = await this.evalInSw(ext, pollExpr);
            } catch {
                continue;
            }
            if (pr.err || pr.value === undefined) continue;
            try {
                const arr = JSON.parse(String(pr.value));
                if (Array.isArray(arr) && arr.length) return { data: arr };
            } catch {}
        }
        return { data: undefined };
    }

    /**
     * 端口常驻泵（宿主侧）：routePortMessage 的 outbox 轮询窗口有限且取到首批
     * 即返回 —— GM_xmlhttpRequest 的真实响应晚数百 ms 到达时无人再取，永远滞留
     * __syPortOutbox（实测 xhr 响应数据滞留、onerror/ontimeout 全部饿死）。
     * 世界侧 connect 后由泵每 600ms 调 portpoll，这里单次原子取走指定端口的
     * 全部滞留回包交回世界派发。排空是 splice 原子操作，与 routePortMessage
     * 的轮询竞争也不会重复投递。
     */
    private async portPoll(ext: ICsExtInfo, args: any): Promise<{ data?: any; err?: string }> {
        const ids = Array.isArray(args?.ids) ? args.ids.map(String).slice(0, 64) : [];
        if (!ids.length) return { data: [] };
        const expr = `(function () {
            var ids = ${JSON.stringify(ids)};
            var out = [];
            try {
                var box = self.__syPortOutbox || {};
                for (var i = 0; i < ids.length; i++) {
                    var arr = box[ids[i]];
                    if (arr && arr.length) out.push({ portId: ids[i], msgs: arr.splice(0, arr.length) });
                }
            } catch (e) {}
            return JSON.stringify(out);
        })()`;
        const r = await this.evalInSw(ext, expr);
        if (r.err) return { err: r.err };
        try { return { data: JSON.parse(String(r.value)) }; } catch { return { data: [] }; }
    }

    /**
     * 把"当前标签"喂进 SW 的 tab 注册表（垫片 v5 收集的 tabs 事件 listeners）。
     * AdGuard 的 tabsApi 纯靠 tabs.onCreated/onUpdated 维护 tabContext Map，
     * Electron 下事件缺失 → getTabContext 恒 undefined → popup 取状态静默失败。
     * tabId 与垫片 tabs.query 返回的固定 id=1 对齐。
     */
    private async feedTabEventToSw(ext: ICsExtInfo, args: any): Promise<{ data?: any; err?: string }> {
        const tabJson = JSON.stringify({
            id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false,
            incognito: false, url: String(args?.url || ""), title: String(args?.title || ""),
        });
        const expr = `(function () {
            try {
                var tab = ${tabJson};
                // SW 侧 tabs.query 的"活动页签"兜底（垫片 5a-2）：Electron 原生 query
                // 不认 active/lastFocusedWindow，TM 的 popup 会话解析当前页签全靠它
                self.__syLastFedTab = tab;
                var cfns = self.__syTabCreatedFns || [];
                for (var i = 0; i < cfns.length; i++) { try { cfns[i](tab); } catch (e) {} }
                var afns = self.__syTabActivatedFns || [];
                for (var a = 0; a < afns.length; a++) { try { afns[a]({ tabId: tab.id, windowId: tab.windowId }); } catch (e) {} }
                var ufns = self.__syTabUpdatedFns || [];
                for (var j = 0; j < ufns.length; j++) { try { ufns[j](tab.id, { status: "complete", url: tab.url, title: tab.title }, tab); } catch (e) {} }
            } catch (e) {}
            return JSON.stringify({ c: (self.__syTabCreatedFns || []).length });
        })()`;
        const r = await this.evalInSw(ext, expr);
        if (r.err) return { err: r.err };
        // onCreated 监听数为 0 = 扩展 app 尚未初始化（TabsApi.start 未跑）→ 喂了白喂，重试
        try {
            let parsed = JSON.parse(String(r.value));
            let tries = 0;
            while (parsed && parsed.c === 0 && tries < 4) {
                tries++;
                await new Promise((res) => setTimeout(res, 1500));
                const r2 = await this.evalInSw(ext, expr);
                if (r2.err) return { err: r2.err };
                parsed = JSON.parse(String(r2.value));
            }
        } catch {}
        return { data: "ok" };
    }

    /** popup 世界 tabs.sendMessage → content 世界的 onMessage 监听器直调 */    private async dispatchToContentWorld(ext: ICsExtInfo, args: any): Promise<{ data?: any; err?: string }> {
        const ctxId = this.contentWorlds.get(ext.electronId);
        if (!ctxId) return { data: undefined }; // 内容世界未就绪（页面刚导航？）——按无接收方回调 undefined
        const msgJson = JSON.stringify(args.msg === undefined ? null : args.msg);
        const senderJson = JSON.stringify({
            tab: { id: typeof args.tabId === "number" ? args.tabId : 1 },
            url: String(args.senderUrl || "").slice(0, 300),
        });
        const r = await this.send(
            "Runtime.evaluate",
            {
                expression: `(async () => {
                    const fns = self.__syCsOnMessageFns || [];
                    if (!fns.length) return JSON.stringify({ __noReceivers: true });
                    return await new Promise((resolve) => {
                        let done = false;
                        const finish = (v) => {
                            if (done) return;
                            done = true;
                            clearTimeout(timer);
                            resolve(JSON.stringify(v === undefined ? null : v));
                        };
                        // 20s：宿主 route 内部等待须 < 桥超时 25s（留 5s 给回写与传输），
                        // 否则宿主还在等、CS 端桥先断（假超时 Uncaught，响应实际已在途）
                        const timer = setTimeout(() => finish(null), 20000);
                        let asyncWait = false;
                        const sendResponse = (resp) => finish(resp);
                        // handler 返回 Promise（async 函数）→ 等其 resolve 作为响应
                        const useValue = (v) => { if (v !== undefined) finish(v); };
                        for (const fn of fns) {
                            try {
                                const r = fn(${msgJson}, ${senderJson}, sendResponse);
                                if (r === true) {
                                    asyncWait = true;
                                } else if (r !== undefined) {
                                    if (typeof r.then === "function") {
                                        asyncWait = true;
                                        // async handler resolve undefined（fire-and-forget 型，
                                // 如 Clip eventDispatcher 处理完 tip 直接 return）→
                                // 必须立即 finish，否则挂到 20s 兜底（完成提示延迟的真凶）
                                r.then((v) => { if (v === undefined) finish(undefined); else useValue(v); }, () => finish(undefined));
                                    } else {
                                        finish(r);
                                        break;
                                    }
                                }
                            } catch (e) {}
                        }
                        if (!asyncWait && !done) finish(undefined);
                    });
                })()`,
                contextId: ctxId,
                returnByValue: true,
                awaitPromise: true,
            },
            22000 // 内部 expr 兜底 20s + evaluate 传输余量；须 < 桥超时 25s
        );
        if ((r as any)?.exceptionDetails) {
            return { err: String((r as any).exceptionDetails?.exception?.description || "content world 派发异常").slice(0, 200) };
        }
        try {
            const parsed = JSON.parse(String((r as any)?.result?.value));
            if (parsed && parsed.__noReceivers) return { data: undefined };
            return { data: parsed === null ? undefined : parsed };
        } catch {
            return { data: undefined };
        }
    }

    /** 在指定执行上下文里 evaluate（供 popup 世界等复用）。
     *  超大表达式分块传输：实测 1.8MB 的 expression 经 debugger 通道会静默无效
     *  （返回 ok 但脚本未执行），分块 push 后 eval 组装可绕过。 */
    async evaluateInWorld(ctxId: number, expr: string, timeoutMs = 30000): Promise<{ ok: boolean; value?: any; error?: string }> {
        try {
            if (expr.length > 150_000) {
                // 直发一次 + 落地标记：大 expression 的"静默无效"（返回 ok 但未执行）
                // 用标记求值检测；生效则免去整个分块传输
                const bigMark = "syBig" + Date.now().toString(36);
                const r0: any = await this.send(
                    "Runtime.evaluate",
                    { expression: expr + `;self["${bigMark}"]=1;`, contextId: ctxId, returnByValue: false },
                    timeoutMs
                );
                const c0: any = await this.send(
                    "Runtime.evaluate",
                    { expression: `self["${bigMark}"]===1`, contextId: ctxId, returnByValue: true },
                    timeoutMs
                );
                if (c0?.result?.value === true) {
                    return { ok: true, value: r0?.result?.value };
                }
                const CHUNK = 100_000;
                const totalChunks = Math.ceil(expr.length / CHUNK);
                const djb2 = (str: string): number => {
                    let h = 5381;
                    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
                    return h >>> 0;
                };
                // 逐块推送 + 校验和回执：回执只证"到了几块"不证"内容没坏"
                // （实测 TM extension.js 各块全到、join 后却语法错误 → 内容级损坏）。
                // 校验和不匹配时二分降级重发，直到该块的全部碎片校验通过。
                const pushVerified = async (piece: string, depth: number): Promise<boolean> => {
                    const exprPush =
                        "(() => { try {" +
                        " if (!self.__syBigSrc) self.__syBigSrc = [];" +
                        " const s = " + JSON.stringify(piece) + ";" +
                        " self.__syBigSrc.push(s);" +
                        " let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;" +
                        " return { len: s.length, sum: h >>> 0, total: self.__syBigSrc.length };" +
                        " } catch (e) { return { error: String(e && e.message || e) }; } })()";
                    const r: any = await this.send(
                        "Runtime.evaluate",
                        { expression: exprPush, contextId: ctxId, returnByValue: true },
                        timeoutMs
                    );
                    if (r?.exceptionDetails) return false;
                    const v = r?.result?.value;
                    if (!v || v.error) return false;
                    if (v.len === piece.length && v.sum === djb2(piece)) return true;
                    if (depth >= 6 || piece.length <= 4096) return false;
                    // 二分降级：坏的尺寸段拆两半分别推（推前清掉这条坏块）
                    await this.send("Runtime.evaluate", { expression: "self.__syBigSrc.pop()", contextId: ctxId }, timeoutMs);
                    const mid = Math.floor(piece.length / 2);
                    return (
                        (await pushVerified(piece.slice(0, mid), depth + 1)) &&
                        (await pushVerified(piece.slice(mid), depth + 1))
                    );
                };
                // debugger 通道的大 expression 会"静默无效"（返回 ok 但未执行，实测
                // TM extension.js 534KB 分 6 块时丢 1 块 → join 后 unterminated 语法
                // 错误）—— 每块推送后回读 __syBigSrc.length 校验，失败重发。
                for (let i = 0; i < expr.length; i += CHUNK) {
                    const piece = expr.slice(i, i + CHUNK);
                    if (!(await pushVerified(piece, 0))) {
                        return { ok: false, error: `分块传输失败：chunk ${Math.floor(i / CHUNK) + 1}/${totalChunks} 校验未通过` };
                    }
                }
                // 自包含组合执行器：join → 内容哈希 → eval，失败落 new Function，
                // 全败时带回内容哈希与首尾样本（一次求值拿全所有诊断，避免跨求值
                // 的间歇性静默失效干扰定位）
                const runExpr =
                    "(() => { try {" +
                    " const j = self.__syBigSrc.join('');" +
                    " let h = 5381; for (let i = 0; i < j.length; i++) h = ((h << 5) + h + j.charCodeAt(i)) | 0;" +
                    " const r = { len: j.length, sum: h >>> 0 };" +
                    " try { (0, eval)(j); r.viaEval = true; } catch (e1) { r.evalErr = String(e1 && e1.message || e1).slice(0, 160); }" +
                    " if (!r.viaEval) { try { new Function(j)(); r.viaFn = true; } catch (e2) { r.fnErr = String(e2 && e2.message || e2).slice(0, 160); } }" +
                    " r.head = j.slice(0, 60); r.tail = j.slice(-60);" +
                    " return JSON.stringify(r);" +
                    " } catch (e) { return JSON.stringify({ fatal: String(e && e.message || e).slice(0, 160) }); } })()";
                const r: any = await this.send(
                    "Runtime.evaluate",
                    { expression: runExpr, contextId: ctxId, returnByValue: true, awaitPromise: false },
                    timeoutMs
                );
                let runState: any = null;
                try { runState = r?.result?.value ? JSON.parse(String(r.result.value)) : null; } catch {}
                if (!runState || runState.fatal) {
                    return { ok: false, error: "分块执行器未生效: " + JSON.stringify(runState).slice(0, 200) };
                }
                if (runState.viaEval || runState.viaFn) {
                    return { ok: true, value: undefined };
                }
                if (r?.exceptionDetails) {
                    return {
                        ok: false,
                        error: `分块 eval 失败: evalErr=${runState.evalErr || "-"} fnErr=${runState.fnErr || "-"} len=${runState.len}/${expr.length} sum=${runState.sum}/${djb2(expr)} head=${runState.head} tail=${runState.tail}`,
                    };
                }
                return { ok: true };
            }
            const r: any = await this.send(
                "Runtime.evaluate",
                { expression: expr, contextId: ctxId, returnByValue: true, awaitPromise: true },
                timeoutMs
            );
            if (r?.exceptionDetails) {
                return {
                    ok: false,
                    error: String(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "执行异常").slice(0, 300),
                };
            }
            return { ok: true, value: r?.result?.value };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
        }
    }

    /** 重新取主框架 id（导航后 frameId 会变） */
    async refreshFrameId(): Promise<void> {
        const tree: any = await this.send("Page.getFrameTree");
        this.frameId = tree?.frameTree?.frame?.id || tree?.frame?.id || null;
    }

    /** 探测执行上下文是否可用（写入 + 读回） */
    async probeWorld(ctxId: number): Promise<boolean> {
        try {
            await this.send("Runtime.evaluate", { expression: "self.__syWorldProbe = 1", contextId: ctxId }, 8000);
            const r: any = await this.send(
                "Runtime.evaluate",
                { expression: "self.__syWorldProbe === 1", contextId: ctxId, returnByValue: true },
                8000
            );
            return r?.result?.value === true;
        } catch {
            return false;
        }
    }

    /** 当前 popup 世界的 contextId（未 begin 时返回 null） */
    currentPopupCtx(electronId: string): number | null {
        return this.popupWorldByExt.get(electronId) || null;
    }

    /** 确保扩展的 popup 世界（★ 每次打开面板都新建 —— 世界跨打开持久会让旧垫片/旧声明残留），返回 contextId */
    async ensurePopupWorld(ext: ICsExtInfo): Promise<number> {
        if (!this.alive || !this.frameId) throw new Error("CDP 会话未就绪");
        const r: any = await this.send("Page.createIsolatedWorld", {
            frameId: this.frameId,
            worldName: POPUP_WORLD_PREFIX + ext.electronId + "-" + Date.now().toString(36),
            grantUniversalAccess: true,
            allowCommandLineAPI: false,
        });
        const ctxId = r?.executionContextId;
        if (!ctxId) throw new Error("createIsolatedWorld 未返回 contextId");
        this.popupWorldByExt.set(ext.electronId, ctxId);
        this.popupCtxs.set(ctxId, ext.electronId);
        await this.send("Runtime.addBinding", { name: BRIDGE_NAME, executionContextId: ctxId });
        const shim = buildShim(ext, this.host.messages(ext.path, ext.defaultLocale));
        const sr: any = await this.send("Runtime.evaluate", { expression: shim, contextId: ctxId, returnByValue: false });
        if (sr?.exceptionDetails) {
            throw new Error("popup 垫片执行异常: " + String(sr.exceptionDetails?.exception?.description || sr.exceptionDetails?.text).slice(0, 200));
        }
        return ctxId;
    }

    /**
     * flat 版 isolated world 直调（无 --remote-debugging-port 也可用）：
     * Target.getTargets 按 URL 找页面 target → attachToTarget{flatten} →
     * 该 flat session 里 Runtime.enable（会重放 executionContextCreated，
     * 事件经 debugger "message" 事件带 sessionId 到达）→ 按
     * __syCsRt_<electronId> 前缀（cs-runtime 自建世界）或 isolated+origin
     * 匹配 contextId → Runtime.evaluate。用完 detachFromTarget 清理。
     */
    async evalInExtensionWorldFlat(electronId: string, expr: string): Promise<{ ok: boolean; value?: any; error?: string; contextId?: number }> {
        const pageUrl = this.pageUrl;
        const norm = (u: string) => String(u || "").split("#")[0];
        let sid: string | null = null;
        let handler: ((_e: any, method: string, params: any, evtSid?: string) => void) | null = null;
        try {
            // 优先用会话自身的 target（Target.getTargetInfo 无参 = 当前 attach 的
            // target）—— 多个同 URL webview 并存时按 URL 匹配会选错（陈旧目标），
            // 实测 flat 注入 usInjected=false 假象的根源之一。
            let page: { targetId: string; url?: string; type?: string } | null = null;
            try {
                const own: any = await this.send("Target.getTargetInfo");
                const ti = own?.targetInfo;
                if (ti && ti.targetId && (ti.type === "webview" || ti.type === "page" || ti.type === "iframe")) {
                    page = { targetId: ti.targetId, url: ti.url, type: ti.type };
                }
            } catch {}
            if (!page) {
                const r = await this.send("Target.getTargets");
                const infos: any[] = (r && r.targetInfos) || [];
                const pages = infos.filter((t) => t.type === "webview" || t.type === "page" || t.type === "iframe");
                page = pages.find((t) => norm(t.url) === norm(pageUrl))
                    || pages.find((t) => pageUrl && norm(t.url) === norm(pageUrl.split("?")[0]))
                    || null;
            }
            if (!page) return { ok: false, error: "未找到页面 CDP target" };
            const a: any = await this.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
            sid = a && a.sessionId;
            if (!sid) return { ok: false, error: "attachToTarget 未返回 sessionId" };

            let extContextId: number | null = null;
            handler = (_e: any, method: string, params: any, evtSid?: string) => {
                if (evtSid !== sid || method !== "Runtime.executionContextCreated") return;
                const c = params?.context || {};
                const isIsolated = c.type === "isolated" || (c.auxData && c.auxData.type === "isolated");
                if (String(c.name || "").indexOf(CS_WORLD_PREFIX) === 0) {
                    // 自建世界优先 —— Electron 原生世界的 CS 已因空壳 chrome 抛错
                    if (c.name.slice(CS_WORLD_PREFIX.length) === electronId) extContextId = c.id;
                    return;
                }
                if (isIsolated && String(c.origin || "").includes(electronId)) extContextId = c.id;
            };
            this.wc.debugger.on("message", handler);
            await this.send("Runtime.enable", {}, 8000, sid);
            // 上下文事件可能未及时到达，轮询等待
            for (let i = 0; i < 20 && extContextId === null; i++) {
                await new Promise((r2) => setTimeout(r2, 200));
            }
            if (extContextId === null) {
                return { ok: false, error: "该页面没有此扩展的运行时世界（页面未加载完成或 cs-runtime 未就绪）" };
            }
            const er: any = await this.send(
                "Runtime.evaluate",
                { expression: expr, returnByValue: true, awaitPromise: true, contextId: extContextId },
                15000,
                sid
            );
            if (er && er.exceptionDetails) {
                return {
                    ok: false,
                    error: String(er.exceptionDetails?.exception?.description || er.exceptionDetails?.text || "isolated world 执行异常").slice(0, 300),
                    contextId: extContextId,
                };
            }
            return { ok: true, value: er && er.result ? er.result.value : null, contextId: extContextId };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
        } finally {
            if (handler) {
                try { this.wc.debugger.off("message", handler); } catch {}
            }
            if (sid) {
                try { this.send("Target.detachFromTarget", { sessionId: sid }, 3000, sid); } catch {}
            }
        }
    }

    async evalInSw(ext: ICsExtInfo, expr: string): Promise<{ value?: any; err?: string }> {
        let eid = ext.electronId;
        // HTTP CDP 熔断生效时直接走进程内 flat 通道（正常启动无 --remote-debugging-port）。
        // ★ 唤醒只允许发生在对应通道内部：flat 路径绝不能先 wakeOne —— 会把已预热的
        //    SW remove+load 重启，扩展 app 重新初始化，popup 首开必撞空 handler。
        let target = cdpHttpLikelyDead() ? null : await findSwTarget(eid);
        if (!target && !cdpHttpLikelyDead()) {
            // HTTP 通道存在但 SW 休眠 → 无副作用唤醒（★避免 remove+load 杀面板世界），
            // 仍找不到才走 wakeOne（全量重载 + id 同步）
            const wakeA = this.host.wakeSw
                ? async () => { await this.host.wakeSw!(eid); }
                : async () => { eid = (await this.host.wakeOne(eid).then((r) => (typeof r === "string" ? r : eid)).catch(() => eid)) || eid; };
            await wakeA();
            for (let i = 0; i < 10 && !target; i++) {
                await new Promise((r) => setTimeout(r, 300));
                target = await findSwTarget(eid);
            }
            if (!target && this.host.wakeSw) {
                const fresh = await this.host.wakeOne(eid).then((r) => (typeof r === "string" ? r : eid)).catch(() => eid);
                eid = fresh || eid;
                for (let i = 0; i < 10 && !target; i++) {
                    await new Promise((r) => setTimeout(r, 300));
                    target = await findSwTarget(eid);
                }
            }
        }
        if (!target) {
            // flat 通道（正常启动）：SW 活着就直接 evaluate；不活着由 flat 内部 wake。
            // ★ wake 必须无副作用（startWorkerForScope）—— remove+load 会把正在打开的
            //   面板世界连 binding 一起销毁，popup.js 首个 storage 调用永挂 → 面板全白
            const flat = await evalInSwFlat(
                (method, params, sessionId) => Promise.race([
                    this.wc.debugger.sendCommand(method, params, sessionId),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 12000)),
                ]),
                eid,
                expr,
                async () => {
                    if (this.host.wakeSw) await this.host.wakeSw(eid);
                    else await this.host.wakeOne(eid);
                }
            );
            if (flat.err !== SW_FLAT_UNAVAILABLE) return flat;
            const alt = await evalInSwViaMainWindow(eid, expr);
            if (alt.err !== SW_FLAT_UNAVAILABLE) return alt;
            return { err: "扩展 SW 未运行且唤醒失败（CDP 不可用？）" };
        }
        const r = await cdpEvalOnce(target.webSocketDebuggerUrl, expr, 12000);
        if (r && typeof r === "object" && r.err) return { err: String(r.err) };
        return { value: r };
    }
}

/** 主窗口 debugger 兜底（webview 会话不可用时；attach 与 DevTools 互斥，用完即 detach） */
async function evalInSwViaMainWindow(electronId: string, expr: string, wake?: () => Promise<void>): Promise<{ value?: any; err?: string }> {
    let attachedHere = false;
    try {
        const req = (window as any).require;
        if (!req) return { err: SW_FLAT_UNAVAILABLE };
        const remote = req("@electron/remote");
        const wc = remote.getCurrentWebContents();
        const dbg = wc.debugger;
        if (!dbg.isAttached()) {
            dbg.attach("1.3");
            attachedHere = true;
        }
        const sender = (method: string, params?: any, sessionId?: string) =>
            Promise.race([
                dbg.sendCommand(method, params, sessionId),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 12000)),
            ]);
        return await evalInSwFlat(sender, electronId, expr, wake);
    } catch (e: any) {
        // attach 失败（如用户开着 DevTools）按通道不可用处理
        void e;
        return { err: SW_FLAT_UNAVAILABLE };
    } finally {
        if (attachedHere) {
            try {
                (window as any).require("@electron/remote").getCurrentWebContents().debugger.detach();
            } catch {}
        }
    }
}

/** manager 级 SW eval（供 contextMenus 等无 webview 上下文的调用方使用）：
 *  任一存活 webview 会话的 evalInSw（HTTP→flat 双通道），没有则主窗口兜底 */
export function evalInSwBridge(ext: { electronId: string }, expr: string): Promise<{ value?: any; err?: string }> {
    if (!manager) return Promise.resolve({ err: "cs-runtime 未初始化" });
    return manager.evalInSwAny(ext.electronId, expr);
}

/** manager 级 isolated world 直调（flat 通道，无调试端口也可用）——Clip 划词等 */
export function evalInExtensionWorldBridge(webview: IWebviewTag, electronId: string, expr: string): Promise<{ ok: boolean; value?: any; error?: string; contextId?: number }> {
    if (!manager) return Promise.resolve({ ok: false, error: "cs-runtime 未初始化" });
    return manager.evalExtensionWorldAny(webview, electronId, expr);
}

/** 确保扩展自建世界存在（chrome.userScripts 注册脚本注入的前置） */
export async function ensureExtensionWorld(webview: IWebviewTag, ext: ICsExtInfo): Promise<void> {
    if (!manager) throw new Error("cs-runtime 未初始化");
    return manager.ensureExtensionWorld(webview, ext);
}

function safeUrl(webview: IWebviewTag): string {
    try {
        return webview.getURL?.() || "";
    } catch {
        return "";
    }
}

// ===== 注入到自建世界的 chrome.* 垫片 =====

function buildShim(ext: ICsExtInfo, messages: Record<string, any>): string {
    const extData = JSON.stringify({
        id: ext.electronId,
        name: ext.name,
        version: ext.version,
        senderPageUrl: ext.senderPageUrl || "",
        senderTabId: typeof ext.senderTabId === "number" ? ext.senderTabId : null,
    });
    const messagesJson = JSON.stringify(messages || {});
    return `
(function () {
    if (window.__syCsRtShim) return;
    window.__syCsRtShim = true;
    var EXT = ${extData};
    var MESSAGES = ${messagesJson};
    var __seq = 0, __pending = {};
    window.__syExtHostResolve = function (json) {
        try {
            var r = JSON.parse(json);
            var p = __pending[r.reqId];
            if (!p) return;
            delete __pending[r.reqId];
            clearTimeout(p.timer);
            if (r.err) p.reject(new Error(r.err)); else p.resolve(r.data);
        } catch (e) {}
    };
    function hostCallOnce(type, args) {
        return new Promise(function (resolve, reject) {
            var reqId = "q" + (++__seq) + Math.random().toString(36).slice(2, 8);
            var rec = { resolve: resolve, reject: reject, timer: 0 };
            __pending[reqId] = rec;
            rec.timer = setTimeout(function () {
                if (__pending[reqId]) { delete __pending[reqId]; reject(new Error("__syExtHost bridge timeout")); }
                // 25s：与宿主 route 内部超时（sendmessage expr 25s、__noHandlers 重试
                // 3×1.5s、evalInSw 各级 12s）对齐 —— 此前 12s 比宿主内部等待更短，
                // 宿主还在正常等待/重试时桥先断，产生假超时报错（剪藏实际成功）。
            }, 25000);
            try {
                window.${BRIDGE_NAME}(JSON.stringify({ reqId: reqId, type: type, args: args === undefined ? null : args }));
            } catch (e) {
                clearTimeout(rec.timer);
                delete __pending[reqId];
                reject(e);
            }
        });
    }
    // 桥调用超时自动重试一次：SW 冷唤醒窗口期（巨型 background 顶层执行）首调可能
    // 撞上超时，此时 SW 已醒、重发即成功。有副作用的 sendmessage/tabs-sendmessage
    // 不重试（避免重复剪藏）。
    function hostCall(type, args) {
        var p = hostCallOnce(type, args);
        if (type === "sendmessage" || type === "tabs-sendmessage") return p;
        return p.catch(function (e) {
            if (e && /bridge timeout/.test(String(e && e.message || e))) return hostCallOnce(type, args);
            throw e;
        });
    }
    function cbStyle(p, cb) {
        if (typeof cb === "function") {
            p.then(function (v) { try { cb(v); } catch (e) {} }, function () { try { cb(undefined); } catch (e) {} });
        }
        return p;
    }
    // 大消息（如 upload-copy：整页 DOM + 图片 base64，可达数 MB）既不能单次走
    // binding（实测大 payload 挂死），也不能经 chrome.storage 绕行 —— CS 世界的
    // storage 本身就走 binding（同一条会挂死的通道，旧方案此处即 25s 桥超时）。
    // 根源方案：把大 JSON 切成 <400KB 的小块逐次过 binding（单块实测安全），
    // 宿主内存拼装后走常规路由（见宿主 route 的 bigmsg-chunk / sendmessage-big）。
    // sender 身份：popup/扩展页面世界用宿主传入的扩展页 URL（真 Chrome 里
    // 弹出面板就是 chrome-extension:// 文档）；内容脚本世界回退本页 URL。
    // senderTabId：内容世界的 tab 归属（真 Chrome 的 sender.tab）。
    function senderUrl() {
        try { return EXT.senderPageUrl || String(location.href).slice(0, 300); } catch (e) { return ""; }
    }
    function senderTabId() {
        return (EXT.senderTabId === null || EXT.senderTabId === undefined) ? null : EXT.senderTabId;
    }
    function sendMessageShim(msg, cb) {
        var json = null;
        try { json = JSON.stringify(msg === undefined ? null : msg); } catch (e) {}
        if (json && json.length > 600000) {
            var bid = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            var CHUNK = 400000;
            var total = Math.ceil(json.length / CHUNK);
            var p = Promise.resolve();
            for (var i = 0; i < total; i++) {
                (function (idx, piece) {
                    p = p.then(function () {
                        return hostCall("bigmsg-chunk", { id: bid, idx: idx, total: total, data: piece });
                    });
                })(i, json.slice(i * CHUNK, (i + 1) * CHUNK));
            }
            return cbStyle(p.then(function () {
                return hostCall("sendmessage-big", { id: bid, senderUrl: senderUrl(), tabId: senderTabId() });
            }), cb);
        }
        return cbStyle(hostCall("sendmessage", { msg: msg === undefined ? null : msg, senderUrl: senderUrl(), tabId: senderTabId() }), cb);
    }
    // 端口常驻泵（世界侧）：长活端口的回包随时可能到达，而 portmessage 只在发送时
    // 捎带一轮 outbox 拉取（取到首批即返回）—— GM_xmlhttpRequest 这类"发完就等"的
    // 端口，真实响应晚数百 ms 到达后无人再取，永久滞留 SW outbox（实测 xhr 回包
    // 饿死：onload/onerror/ontimeout 全不触发）。泵每 600ms 统一拉取所有开放端口，
    // busy 标志防 SW 冷启动期求值堆积；无开放端口自动停摆。
    if (!self.__syEnsurePortPump) {
        self.__syOpenPorts = {};
        self.__syEnsurePortPump = function () {
            if (self.__syPortPump) return;
            self.__syPortPump = setInterval(function () {
                if (self.__syPumpBusy) return;
                var ids = Object.keys(self.__syOpenPorts || {});
                if (!ids.length) { clearInterval(self.__syPortPump); self.__syPortPump = 0; return; }
                self.__syPumpBusy = true;
                hostCall("portpoll", { ids: ids }).then(function (groups) {
                    if (Array.isArray(groups)) {
                        for (var i = 0; i < groups.length; i++) {
                            var g = groups[i];
                            var p = (self.__syOpenPorts || {})[g && g.portId];
                            if (p && Array.isArray(g.msgs)) {
                                for (var j = 0; j < g.msgs.length; j++) p.onMessage.dispatch(g.msgs[j]);
                            }
                        }
                    }
                }).catch(function () {}).then(function () { self.__syPumpBusy = false; });
            }, 600);
        };
    }
    // 内核请求代理：https 页面的隔离世界 fetch http://127.0.0.1/<localhost> 是
    // mixed content，直接 "Failed to fetch"（实测 Clip 发送/笔记本列表全挂）。
    // 内核 URL 转经宿主桥，宿主用 Node http 代发（绕开浏览器 fetch 限制）。
    try {
        var oFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                var url = typeof input === "string" ? input : (input && input.url) || "";
                if (/^http:\\/\\/(127\\.0\\.0\\.1|localhost)(:\\d+)?/i.test(url)) {
                    var headers = {};
                    if (init && init.headers) {
                        if (typeof init.headers.forEach === "function") {
                            init.headers.forEach(function (v, k) { headers[k] = v; });
                        } else {
                            for (var k in init.headers) { headers[k] = init.headers[k]; }
                        }
                    }
                    return hostCall("kernelfetch", {
                        url: url,
                        method: (init && init.method) || "GET",
                        headers: headers,
                        body: (init && init.body) === undefined || (init && init.body) === null ? null : String(init.body),
                    }).then(function (r) {
                        var resp = (typeof r === "string") ? JSON.parse(r) : (r || {});
                        var st = resp.status || 0;
                        if (st < 200) throw new TypeError("Failed to fetch");
                        return new Response(resp.bodyText || "", { status: st });
                    });
                }
            } catch (e) {}
            return oFetch.apply(window, arguments);
        };
    } catch (e) {}
    // API 调用轨迹（调试扩展初始化卡点；self.__syApiLog 由宿主或探针读取）
    var __traceDepth = 0;
    function traced(name, fn) {
        return function () {
            var args = arguments;
            try { (self.__syApiLog = self.__syApiLog || []).push(new Array(__traceDepth + 1).join("  ") + name + "()"); } catch (e) {}
            __traceDepth++;
            var done = function (v) { __traceDepth--; return v; };
            var r = fn.apply(null, args);
            if (r && typeof r.then === "function") {
                return r.then(
                    function (v) { return done(v); },
                    function (e) { try { (self.__syApiLog = self.__syApiLog || []).push(new Array(__traceDepth + 1).join("  ") + name + " REJECT: " + String(e && e.message || e).slice(0, 120)); } catch (e2) {} __traceDepth--; throw e; }
                );
            }
            __traceDepth--;
            return r;
        };
    }
    // 事件存根（onConnect/onInstalled 等：扩展初始化期常直接 addListener，
    // 缺失会 TypeError "Cannot read properties of undefined (reading 'addListener')"）
    var eventHub = function () {
        var fns = [];
        return {
            addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
            removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
            hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
        };
    };
    window.chrome = window.chrome || {};
    // ★ 整体替换 chrome 对象：世界里的 chrome 可能是 Electron 原生绑定
    //   （storage.local 真实可用、但访问 storage.sync 会原生抛
    //   "sync" is not available in this instance of Chrome），逐属性赋值
    //   对原生访问器会被静默忽略。整体替换后所有命名空间都是我们的实现。
    var chrome_ = {};
    chrome_.runtime = {
        id: EXT.id,
        // lastError 是 callback 风格 API 的错误检查口：本实现全 promise 化
        //（错误走 reject），恒为 undefined —— 显式预置，避免扩展代码访问时
        // 掉进通用桩代理（[sy-ext-shim] chrome.runtime.lastError 未实现 warn）
        lastError: undefined,
        getManifest: function () { return { manifest_version: 3, name: EXT.name, version: EXT.version }; },
        getURL: function (p) { return "chrome-extension://" + EXT.id + "/" + String(p || "").replace(/^\\//, ""); },
        onMessage: (function () {
            var fns = [];
            self.__syCsOnMessageFns = fns;
            return {
                addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
            };
        })(),
        sendMessage: sendMessageShim,
        // 长连接端口：postMessage 经宿主 routePortMessage 派发到 SW 的
        // onConnect 端口处理器（垫片 v5），outbox 回包 dispatch 给本端监听器。
        // portId 跨 postMessage 复用 —— 同一 connect 会话对应 SW 里同一个 port。
        connect: traced("runtime.connect", function (info) {
            var listeners = [];
            var portId = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            var port = {
                name: (info && info.name) || "",
                sender: undefined,
                error: null,
                onMessage: {
                    addListener: function (fn) { if (typeof fn === "function") listeners.push(fn); },
                    removeListener: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
                    hasListener: function (fn) { return listeners.indexOf(fn) >= 0; },
                    dispatch: function (msg) { listeners.forEach(function (fn) { try { fn(msg, port); } catch (e) {} }); },
                },
                onDisconnect: eventHub(),
                postMessage: function (msg) {
                    hostCall("portmessage", {
                        portId: portId,
                        portName: (info && info.name) || "",
                        msg: msg === undefined ? null : msg,
                        senderUrl: senderUrl(),
                        tabId: senderTabId(),
                    }).then(function (resp) {
                        if (Array.isArray(resp)) {
                            resp.forEach(function (item) { port.onMessage.dispatch(item); });
                        } else if (resp !== undefined) {
                            port.onMessage.dispatch(resp);
                        }
                    }).catch(function () {});
                },
                disconnect: function () { delete (self.__syOpenPorts || {})[portId]; },
            };
            // 注册进常驻泵：xhr/values 这类端口的响应到达时间与发送解耦，
            // 只靠 portmessage 捎带轮询会滞留 outbox（见 __syEnsurePortPump 注释）
            self.__syOpenPorts = self.__syOpenPorts || {};
            self.__syOpenPorts[portId] = port;
            self.__syEnsurePortPump();
            return port;
        }),
        // 长连接/生命周期事件（AdGuard 的 MessengerCommon.connect 直接用 onConnect）
        onConnect: eventHub(),
        onConnectExternal: eventHub(),
        onInstalled: eventHub(),
        onStartup: eventHub(),
        onSuspend: eventHub(),
        onSuspendCanceled: eventHub(),
        onUpdateAvailable: eventHub(),
        onRestartRequired: eventHub(),
        onMessageExternal: eventHub(),
        getBackgroundPage: function () { return Promise.resolve(undefined); },
        openOptionsPage: function () { return Promise.resolve(); },
        setUninstallURL: function () {},
        reload: function () {},
        getPlatformInfo: function () { return Promise.resolve({ os: "win", arch: "x86-64", nacl_arch: "x86-64" }); },
    };
    function storageArea(area) {
        return {
            lastError: undefined,
            get: traced(area + ".get", function (keys, cb) { return cbStyle(hostCall("storage", { op: "get", area: area, payload: keys === undefined ? null : keys }), cb); }),
            set: traced(area + ".set", function (items, cb) { return cbStyle(hostCall("storage", { op: "set", area: area, payload: items === undefined ? {} : items }), cb); }),
            remove: traced(area + ".remove", function (keys, cb) { return cbStyle(hostCall("storage", { op: "remove", area: area, payload: keys === undefined ? [] : keys }), cb); }),
            clear: traced(area + ".clear", function (cb) { return cbStyle(hostCall("storage", { op: "clear", area: area, payload: null }), cb); }),
            onChanged: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
        };
    }
    chrome_.storage = { local: storageArea("local"), sync: storageArea("sync"), session: storageArea("session") };
    // 全局 chrome.storage.onChanged（content.js 顶层就用它，缺失即抛 TypeError）
    chrome_.storage.onChanged = { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } };
    chrome_.i18n = {
        getMessage: function (key, args) {
            var entry = MESSAGES[key];
            var msg = entry ? (entry.message || "") : "";
            if (!msg) return "";
            var arr = args == null ? [] : (Array.isArray(args) ? args : [args]);
            // named placeholders（$name$）：按 entry.placeholders[name].content 解析，
            // content 自身可为 "$1" 数字引用或常量文本（实测 TM options 页头
            // "Tampermonkey® by $name$" —— 缺这段占位符原文直接进 DOM）
            var ph = entry && entry.placeholders;
            if (ph) {
                msg = msg.replace(/\\$([A-Za-z_][A-Za-z0-9_]*)\\$/g, function (m, name) {
                    var p = ph[name];
                    if (!p) return m;
                    var c = String(p.content == null ? "" : p.content);
                    return c.replace(/\\$(\\d+)/g, function (m2, i2) {
                        var v = arr[Number(i2) - 1];
                        return v != null ? String(v) : m2;
                    });
                });
            }
            if (msg && args != null) {
                var arr2 = Array.isArray(args) ? args : [args];
                msg = msg.replace(/\\$(\\d+)/g, function (m, i) { return arr2[Number(i) - 1] != null ? arr2[Number(i) - 1] : m; });
            }
            return msg;
        },
        getUILanguage: function () { return navigator.language; },
        // TM popup 初始化会调它并把 undefined 视为错误分支（"getAcceptLanguages
        // returned undefined"）—— 返回浏览器语言列表即可
        getAcceptLanguages: function (cb) {
            var langs = (navigator.languages && navigator.languages.length) ? navigator.languages.slice() : [navigator.language || "en"];
            return cbStyle(Promise.resolve(langs), cb);
        },
    };
    // 新标签页扩展数据适配：Electron 无 topSites/bookmarks/history API，
    // Momentum/Infinity 类新标签页扩展靠它们渲染起始页内容 —— 由宿主用
    // 插件自己的历史/书签库代答（hostCall "usdata"，见宿主路由）。
    chrome_.topSites = {
        get: traced("topSites.get", function (cb) {
            var p = hostCall("usdata", { kind: "topSites" }).then(function (v) { return Array.isArray(v) ? v : []; });
            return cbStyle(p, cb);
        }),
    };
    chrome_.bookmarks = (function () {
        var ev = { onChanged: eventHub(), onCreated: eventHub(), onRemoved: eventHub(), onMoved: eventHub(), onChildrenReordered: eventHub(), onImportBegan: eventHub(), onImportEnded: eventHub() };
        var api = {
            getTree: traced("bookmarks.getTree", function (cb) { return cbStyle(hostCall("usdata", { kind: "bookmarkTree" }), cb); }),
            getChildren: function (id, cb) {
                return cbStyle(hostCall("usdata", { kind: "bookmarkTree" }).then(function (t) {
                    function find(nodes) {
                        for (var i = 0; i < (nodes || []).length; i++) {
                            if (String(nodes[i].id) === String(id)) return nodes[i].children || [];
                            if (nodes[i].children) { var r = find(nodes[i].children); if (r) return r; }
                        }
                        return null;
                    }
                    return Promise.resolve(find(t) || []);
                }), cb);
            },
            getRecent: function (n, cb) {
                return cbStyle(hostCall("usdata", { kind: "bookmarkRecent", n: Number(n) || 10 }).then(function (list) { return Array.isArray(list) ? list : []; }), cb);
            },
            search: function (q, cb) {
                return cbStyle(hostCall("usdata", { kind: "bookmarkSearch", query: typeof q === "string" ? q : String((q && q.query) || "") }).then(function (list) { return Array.isArray(list) ? list : []; }), cb);
            },
            create: function (bm, cb) { return cbStyle(Promise.reject(new Error("bookmarks.create 未适配（只读）")), cb); },
            remove: function (id, cb) { return cbStyle(Promise.resolve(), cb); },
            update: function (id, chg, cb) { return cbStyle(Promise.resolve(), cb); },
            move: function (id, dest, cb) { return cbStyle(Promise.resolve(), cb); },
        };
        for (var k in ev) api[k] = ev[k];
        return api;
    })();
    chrome_.history = (function () {
        var ev = { onVisited: eventHub(), onVisitRemoved: eventHub(), onChanged: eventHub(), onDeleteUrls: eventHub(), onDeleteRange: eventHub(), onDeleteAll: eventHub() };
        var api = {
            search: traced("history.search", function (query, cb) {
                return cbStyle(hostCall("usdata", { kind: "historySearch", query: query === undefined ? null : query }).then(function (list) { return Array.isArray(list) ? list : []; }), cb);
            }),
            getVisits: function (q, cb) { return cbStyle(Promise.resolve([]), cb); },
            addUrl: function (q, cb) { return cbStyle(Promise.resolve(), cb); },
            deleteUrl: function (q, cb) { return cbStyle(Promise.resolve(), cb); },
            deleteRange: function (q, cb) { return cbStyle(Promise.resolve(), cb); },
            deleteAll: function (cb) { return cbStyle(Promise.resolve(), cb); },
        };
        for (var k2 in ev) api[k2] = ev[k2];
        return api;
    })();
    // 通用桩工厂：任意层级的缺失成员都能继续访问/调用（方法返回 Promise<undefined>），
    // 防止 undefined.addListener 之类在扩展初始化期直接崩掉
    var PROMISE_UNDEF = function () { return Promise.resolve(undefined); };
    var STUBS = {};
    var stubFor = function (label) {
        if (!STUBS[label]) {
            try { console.warn("[sy-ext-shim] " + label + " 未实现，返回通用桩"); } catch (e) {}
            var cache = {};
            STUBS[label] = new Proxy(PROMISE_UNDEF, {
                get(_t, prop) {
                    var k = String(prop);
                    if (k === "then") return undefined; // 保持非 thenable
                    if (!cache[k]) cache[k] = stubFor(label + "." + k);
                    return cache[k];
                },
                apply: PROMISE_UNDEF,
            });
        }
        return STUBS[label];
    };
    // 命名空间包装：已实现成员原样返回，缺失成员返回通用桩
    var wrapNs = function (obj, ns) {
        return new Proxy(obj, {
            get(t, prop) {
                if (prop in t) return t[prop];
                var k = String(prop);
                if (typeof prop !== "string" || k === "toJSON") return undefined;
                return stubFor(ns + "." + k);
            },
        });
    };
    if (!chrome_.tabs) {
        chrome_.tabs = {
            lastError: undefined,
            // popup 的"当前标签"就是它所在的页面
            query: function (q, cb) {
                var tab = { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false, incognito: false, url: String(location.href), title: document.title };
                // 顺手把该 tab 喂进 SW 的 tab 注册表（tabevent 通道）——
                // AdGuard 的 tabsApi 靠 tabs 事件建 tabContext，Electron 下事件
                // 缺失，不喂的话 getTabContext 恒 undefined → popup 卡 loading
                try { hostCall("tabevent", { url: tab.url, title: tab.title }).catch(function () {}); } catch (e) {}
                return cbStyle(Promise.resolve([tab]), cb);
            },
            // 派发到本扩展 content 世界的 onMessage 监听器（宿主中转；SW↔CS 路由缺失的替代）
            sendMessage: function (tabId, msg, cb) {
                var p = hostCall("tabs-sendmessage", { tabId: typeof tabId === "number" ? tabId : null, msg: msg === undefined ? null : msg, senderUrl: senderUrl() });
                return cbStyle(p, typeof cb === "function" ? cb : undefined);
            },
        };
    }
    if (!chrome_.dom) chrome_.dom = {};
    // 命名空间级补桩（在整体替换前完成，保证缺失事件也不炸）
    chrome_.runtime = wrapNs(chrome_.runtime, "chrome.runtime");
    chrome_.storage.local = wrapNs(chrome_.storage.local, "chrome.storage.local");
    chrome_.storage.sync = wrapNs(chrome_.storage.sync, "chrome.storage.sync");
    chrome_.storage.session = wrapNs(chrome_.storage.session, "chrome.storage.session");
    chrome_.storage = wrapNs(chrome_.storage, "chrome.storage");
    chrome_.i18n = wrapNs(chrome_.i18n, "chrome.i18n");
    chrome_.tabs = wrapNs(chrome_.tabs, "chrome.tabs");
    // 整体替换挂载（见上方注释：原生访问器属性会被静默忽略，必须整对象替换）。
    // 外层 Proxy：访问未实现的命名空间时返回通用桩（缺失成员可继续嵌套访问/调用），
    // 让重度扩展（如 AdGuard 引用 declarativeNetRequest）不至于在启动期崩掉。
    // 注意：__esModule / default / then / toJSON 必须返回 undefined —— 否则 webpack/rspack
    // 的 ESM interop 会把 chrome 当成 ES 模块（truthy）而去取 chrome.default.runtime → 崩。
    window.chrome = new Proxy(chrome_, {
        get(target, prop) {
            if (prop in target) return target[prop];
            const key = String(prop);
            // ESM interop / 序列化探针：必须保持 falsy，不能返回通用桩
            if (typeof prop !== "string" || key === "__esModule" || key === "default" || key === "then" || key === "toJSON") return undefined;
            return stubFor("chrome." + key);
        },
    });
    // Firefox 风格的 browser.* 命名空间别名（跨浏览器扩展常用；缺了会
    // "Cannot read properties of undefined (reading 'runtime')"）
    try { self.browser = window.chrome; } catch (e) {}
})();
`;
}

