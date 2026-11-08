// Chrome 式扩展 popup 层：独立 chrome-extension:// 文档 + 常温 overlay webview。
//
// 与旧方案（向宿主页面注入 host div + 隔离世界 eval）的本质区别：popup 是
// **独立文档**，加载在专用 webview 里，宿主页面零接触 —— 样式泄漏、body 补丁、
// location 伪装对页面的影响由文档边界结构性消除（对齐 Chrome 的独立扩展文档）。
//
// 生命周期对齐 Chrome 的"文档全新、进程温热"：关闭弹窗 = 隐藏 + 导航到
// about:blank（文档状态与隔离世界随导航销毁，渲染进程/V8 代码缓存/已唤醒的
// SW 保持温热），下次打开直接注入，无冷启动。
import { IWebviewTag } from "../types";
import { BROWSER_PARTITION } from "../constants";
import { injectExtensionPageRuntime, readExtLsSeed, persistExtLs } from "./ext-popup";
import { beginPopupWorld, evalPopupJs, evalInSwByElectronId, ICsExtInfo } from "../extensions/cs-runtime";

export interface PopupOpenOptions {
    extId: string;
    /** 工具栏图标的 viewport 矩形（右下对齐锚点） */
    anchorRect: { right: number; bottom: number };
    extPath: string;
    electronId: string;
    popupPath: string;
    name: string;
    version: string;
    defaultLocale: string;
    contentScripts: Array<{ matches: string[]; js: string[]; css: string[] }>;
    optionsPath?: string;
    userAgent?: string;
    /** 弹窗锚定页（tabs.query 的"当前页签"语义；overlay 真实源架构下必须
     * 显式传入，否则垫片世界把扩展页自己喂给 SW，AdGuard tab 上下文塌掉） */
    anchorTab?: { url: string; title: string };
    onError: (msg: string) => void;
}

// 320 = VM popup 的自然宽度（style.css body{width:320px}，真 Chrome 弹窗同宽）。
// 面板 360 时 guest 里 @media(min-width:360px) 因滚动条占位不命中，body 仍 320
// → 右侧 40px 空白（用户实测"右侧多余 padding"）。初值 320（VM 自然宽度）；
// 打开后按 guest 内容实测宽度自适应（320-480 夹紧）——共享 overlay 的其他
// 扩展面板（如思源剪藏，自然宽度 >320）不再被压窄（用户实测"面板没显示全"）。
let popupW = 320;
const POPUP_H = 520;
/** 扩展面板 DevTools 调试开关（设置项 popupDevtools）：关 = 隐藏 DT 按钮、F12 转发不响应 */
let popupDevtoolsEnabled = false;
export function setPopupDevtoolsEnabled(v: boolean): void {
    popupDevtoolsEnabled = v;
}

export class ExtensionPopupOverlay {
    private tabRoot: HTMLElement;
    private host: HTMLElement | null = null;
    private vw: IWebviewTag | null = null;
    private userAgent: string | undefined;
    private openExtId: string | null = null;   // 当前打开的扩展（null = 无 popup 显示）
    private openRequested = false;             // 已请求注入（等 dom-ready）
    private docReady = false;                  // guest 文档就绪（about:blank 加载完成）
    private activeOpts: PopupOpenOptions | null = null;
    private navRetries = 0;                    // 原生源导航重试计数（>8 = 放弃走兜底）
    private navTimer: ReturnType<typeof setTimeout> | null = null;
    private drainTimer: ReturnType<typeof setInterval> | null = null; // 出箱排空泵（popup 打开期间）
    private onClosedCb: (extId: string) => void;
    private onErrorCb: (msg: string) => void;

    constructor(tabRoot: HTMLElement, cb: { onClosed: (extId: string) => void; onError: (msg: string) => void }) {
        this.tabRoot = tabRoot;
        this.onClosedCb = cb.onClosed;
        this.onErrorCb = cb.onError;
    }

    isOpenFor(extId: string): boolean {
        return this.openExtId === extId && !!this.host && this.host.style.display !== "none";
    }

    isOpen(): boolean {
        return this.openExtId !== null;
    }

    private ensureWarm(): void {
        if (this.host) return;
        const host = document.createElement("div");
        host.className = "sy-ext-popup-overlay";
        host.style.cssText = `position:fixed;z-index:2147483000;width:${popupW}px;height:${POPUP_H}px;display:none;`
            + `background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.28);`;
        // 调试按钮：点击打开 overlay webview 的 DevTools（定位扩展 React 不挂载等问题）
        const dbgBtn = document.createElement("button");
        dbgBtn.textContent = "DT";
        dbgBtn.title = "打开/关闭 DevTools";
        dbgBtn.style.cssText = "position:absolute;top:2px;left:2px;z-index:10;width:24px;height:20px;"
            + "background:#1a73e8;color:#fff;border:none;border-radius:3px;cursor:pointer;"
            + "font-size:10px;font-weight:bold;line-height:20px;text-align:center;padding:0;opacity:.7;";
        dbgBtn.addEventListener("click", () => { this.openGuestDevTools(); });
        host.style.position = "fixed";
        host.style.overflow = "visible";
        host.appendChild(dbgBtn);
        this.tabRoot.appendChild(host);
        this.host = host;
        this.attachGuest();
    }

    /** 新建 guest webview 并挂进 host（首建与死 guest 重建共用） */
    private attachGuest(): void {
        if (!this.host || this.vw) return;
        const vw = document.createElement("webview") as unknown as IWebviewTag;
        vw.setAttribute("src", "about:blank");
        vw.setAttribute("partition", BROWSER_PARTITION);
        // 与页面 webview 同偏好；挂 preload（confirm 抑制 + 缩放 + F12 DevTools 转发）
        vw.setAttribute("webpreferences", "contextIsolation=no,nodeIntegrationInSubFrames=yes");
        try {
            const preloadPath = (window as any).browserPlugin?.getPreloadPathSync?.();
            if (preloadPath) vw.setAttribute("preload", preloadPath);
        } catch {}
        if (this.userAgent) {
            try { vw.useragent = this.userAgent; } catch {}
        }
        vw.style.cssText = "width:100%;height:100%;border:0;";
        // guest → 宿主通道：F12 开 DevTools；localStorage 垫片快照回灌持久化
        vw.addEventListener("ipc-message", (e: any) => {
            if (e.channel === "sy-open-devtools") {
                if (!popupDevtoolsEnabled) return;
                this.openGuestDevTools();
            } else if (e.channel === "sy-ext-ls-write") {
                try {
                    const p = e.args && e.args[0];
                    if (p && p.extId) persistExtLs(String(p.extId), p.data);
                } catch {}
            }
        });
        vw.addEventListener("dom-ready", () => {
            this.docReady = true;
            if (this.openRequested) void this.injectNow();
        });
        vw.addEventListener("crashed", () => {
            // 崩溃后重建 guest：回 about:blank 重新走加载
            try { vw.setAttribute("src", "about:blank"); } catch {}
            this.docReady = false;
        });
        this.host.insertBefore(vw, this.host.firstChild);
        this.vw = vw;
    }

    /** guest 是否存活：getWebContentsId 拿到 id 后 remote.fromId 必须能取到
     *  且未销毁。死 guest 的典型症状 = src 赋值触发 handleWebviewAttributeMutation
     *  → GUEST_VIEW_MANAGER_CALL "Invalid guestInstanceId" 无限刷屏（实测 VM
     *  popup 关闭再开撞上）。 */
    private guestAlive(): boolean {
        const vw = this.vw;
        if (!vw) return false;
        try {
            const id = (vw as any).getWebContentsId?.();
            if (typeof id !== "number") return false;
            const remote = (window as any).require?.("@electron/remote");
            const wc = remote?.webContents?.fromId?.(id);
            return !!wc && !wc.isDestroyed?.();
        } catch {
            return false;
        }
    }

    /** 死 guest 重建：换新 webview 元素（Electron 的 webview guest 被销毁后
     *  元素内残留的 guestInstanceId 永远失效，重设 src 只会无限报错 —— 必须换元素） */
    private rebuildGuestIfDead(): void {
        if (!this.host) return;
        if (this.guestAlive()) return;
        try { this.vw?.remove(); } catch {}
        this.vw = null;
        this.docReady = false;
        this.attachGuest();
    }

    /** 出箱排空泵（popup 打开期间每 1.2s 一次）：VM 这类原生消息流（popup 世界
     *  用 Electron 原生 chrome.runtime.sendMessage → 原生路由到 SW）不经宿主
     *  hostCall 桥，routeSendMessage 完成点的排空永远不触发 —— SW 侧
     *  __syTabCreateOutbox 积压（实测齿轮/加号点击 4 条滞留，页面永不打开）。
     *  泵与桥路由双保险：谁先拿到都行。 */
    private async drainOutboxOnce(electronId: string): Promise<void> {
        try {
            const dr = await evalInSwByElectronId(electronId, "(() => { const o = self.__syTabCreateOutbox || []; self.__syTabCreateOutbox = []; return JSON.stringify(o); })()");
            const items = dr && !dr.err && dr.value ? JSON.parse(String(dr.value)) : [];
            for (const it of (Array.isArray(items) ? items : [])) {
                const u = String((it && it.url) || "");
                if (!u) continue;
                try { (window as any).browserPlugin?.openUrl?.(u, { force: true }); } catch {}
            }
        } catch {}
    }

    private startDrainLoop(electronId: string): void {
        this.stopDrainLoop();
        void this.drainOutboxOnce(electronId);
        this.drainTimer = setInterval(() => void this.drainOutboxOnce(electronId), 1200);
    }

    private stopDrainLoop(): void {
        if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; }
    }

    /** 打开/关闭 overlay webview guest 的 DevTools（DT 按钮与 F12 共用）。
     *  首选 @electron/remote 拿 webContents 调 openDevTools({mode:"detach"})——
     *  独立窗口醒目可见（webview 方法默认停靠形态曾疑似开在主窗后不可见）；
     *  remote 不可用再退 webview 元素方法。guest 失效（重建竞态）时静默跳过
     *  本轮——下一次点击自然用新 guest，不弹误导性错误。 */
    private openGuestDevTools(): void {
        const vw = this.vw;
        if (!vw) return;
        try {
            (vw as any).getWebContentsId?.(); // guest 失效时抛 → 静默跳过本轮
        } catch {
            return;
        }
        try {
            const remote = (window as any).require?.("@electron/remote");
            const id = (vw as any).getWebContentsId?.();
            if (remote?.webContents?.fromId && typeof id === "number") {
                const wc = remote.webContents.fromId(id);
                if (wc) {
                    if (wc.isDevToolsOpened()) { wc.closeDevTools(); } else { wc.openDevTools({ mode: "detach" }); }
                    return;
                }
            }
        } catch (e) {
            console.warn("[browser-plugin] DT remote path failed:", e);
        }
        try {
            if (vw.isDevToolsOpened()) { vw.closeDevTools(); } else { vw.openDevTools({ mode: "detach" } as any); }
        } catch (e) {
            console.warn("[browser-plugin] DT webview path failed:", e);
            this.onErrorCb("打开 DevTools 失败: " + (e instanceof Error ? e.message : e));
        }
    }

    private applyUserAgent(ua?: string): void {
        if (!ua || !this.vw) return;
        try { this.vw.useragent = ua; } catch {}
    }

    /** 按当前 popupW 设置 host 宽度并重算定位（open 与自适应调宽共用） */
    private applySize(): void {
        if (!this.host) return;
        this.host.style.width = popupW + "px";
        const a = this.activeOpts?.anchorRect;
        if (a) {
            const left = Math.max(8, Math.min(a.right - popupW, (window.innerWidth || 800) - popupW - 8));
            const top = Math.max(8, Math.min(a.bottom + 6, (window.innerHeight || 600) - POPUP_H - 8));
            this.host.style.left = left + "px";
            this.host.style.top = top + "px";
        }
        // DT 调试按钮随设置显隐（设置切换后下次打开/自适应时刷新）
        const b = this.host.querySelector("button");
        if (b) (b as HTMLElement).style.display = popupDevtoolsEnabled ? "" : "none";
    }

    /** 打开（已开同一扩展 = no-op；已开其他扩展 = 切换文档） */
    open(opts: PopupOpenOptions): void {
        this.userAgent = opts.userAgent;
        this.ensureWarm();
        this.rebuildGuestIfDead();
        this.startDrainLoop(opts.electronId);
        const sameDoc = this.openExtId === opts.extId && this.isOpenFor(opts.extId);
        this.activeOpts = opts;
        this.openExtId = opts.extId;
        // 定位：右缘对齐图标右缘，顶缘在图标下方；越界收回窗口内
        this.applySize();
        this.host!.style.display = "";
        if (this.userAgent) this.applyUserAgent(this.userAgent);
        if (sameDoc) return; // 同一扩展已显示（注入完成过）——保持现状
        // 全新文档注入：直接导航真实扩展源（Electron 内建扩展 URL 工厂可伺服
        // chrome-extension://<id>/<path>，真源 = 原生 localStorage 持久化 + 原生
        // location 语义；2026-10-31 实测 BrowserWindow/webview 均原生加载成功 ——
        // 早前"被拒退 about:blank"的结论是请求了不存在的根路径 /popup.html 的
        // 假象，真实路径是 pages/popup.html）。原生失败时由 injectNow 按 URL
        // 降级到 about:blank 重建路径。
        this.openRequested = true;
        this.docReady = false;
        const extUrl = "chrome-extension://" + opts.electronId + "/" + String(opts.popupPath).replace(/^\.\//, "");
        const curUrl = (() => { try { return this.vw!.getURL?.() || ""; } catch { return ""; } })();
        if (this.navTimer) { clearTimeout(this.navTimer); this.navTimer = null; }
        this.navRetries = 0;
        if (curUrl === extUrl) {
            // 同 URL 导航会被 Chromium 去重（无 dom-ready）→ reload 强制新文档
            try { this.vw!.reload(); } catch {}
        } else {
            // ★ 必须用 src 属性导航：webview.loadURL() 对 chrome-extension:// 静默
            //   失败（落回 about:blank，2026-10-31 实测），src 赋值则原生加载成功。
            //   但 open() 瞬间 webview 常有挂起导航（close 归位/上一文档），会吃掉
            //   src 赋值 —— 轮询重试直到 getURL 到位；8 次后放弃并归位 about:blank
            //   触发 dom-ready 走重建兜底。
            try { this.vw!.src = extUrl; } catch {}
            let loadTicks = 0;
            const navTick = () => {
                const vw = this.vw;
                if (!vw || this.openExtId !== opts.extId || !this.openRequested) return;
                let cur = ""; try { cur = vw.getURL?.() || ""; } catch {}
                if (cur === extUrl) return; // 到位，等 dom-ready 注入
                // 加载进行中 → 只等待，不重设 src（重设会 abort 在途加载 →
                // ERR_ABORTED → 永远到不了位的活锁；实测 800ms 轮询连打 3 次 abort）
                try { if (vw.isLoading?.()) { loadTicks++; if (loadTicks < 25) this.navTimer = setTimeout(navTick, 800); return; } } catch {}
                this.navRetries++;
                if (this.navRetries > 8) {
                    try { const lp = vw.loadURL?.("about:blank"); if (lp && typeof lp.catch === "function") lp.catch(() => {}); } catch {}
                    return;
                }
                try { vw.src = extUrl; } catch {}
                this.navTimer = setTimeout(navTick, 800);
            };
            this.navTimer = setTimeout(navTick, 800);
        }
    }

    private async injectNow(): Promise<void> {
        const opts = this.activeOpts;
        const vw = this.vw;
        if (!opts || !vw || !this.openRequested) return;
        // 原生加载成功（webview 停在真实扩展源）= 跳过 DOM 重建（原生 DOM
        // 就位）、跳过 location 伪装（原生 location 正确）、跳过 localStorage
        // 垫片（真源原生存储，隔离世界同源共享）。否则走 about:blank 重建兜底。
        let curUrl = ""; try { curUrl = vw.getURL?.() || ""; } catch {}
        const nativeLoad = /^chrome-extension:\/\//i.test(curUrl);
        if (!nativeLoad && this.navRetries <= 8) {
            // 原生源导航还在重试窗口内：本次 dom-ready 是中间态（close 归位的
            // about:blank 等）—— 不消耗 openRequested，等真正的扩展文档到位
            return;
        }
        this.openRequested = false;
        try {
            const pagePath = String(opts.popupPath).replace(/^\.\//, "");
            // 完整 manifest（垫片 getManifest 返回值）：扩展页面脚本深挖字段
            // （实测 VM popup/index.js 读 manifest.options_ui.page / icons），
            // 精简版返回值让 bundle 开头即 TypeError → 面板白屏
            let manifestJson: Record<string, any> | undefined;
            try {
                const nm = (window as any).require("fs") as typeof import("fs");
                const np = (window as any).require("path") as typeof import("path");
                manifestJson = JSON.parse(nm.readFileSync(np.join(opts.extPath, "manifest.json"), "utf8"));
            } catch {}
            const extInfo: ICsExtInfo = {
                electronId: opts.electronId,
                path: opts.extPath,
                name: opts.name,
                version: opts.version,
                defaultLocale: opts.defaultLocale,
                contentScripts: opts.contentScripts,
                optionsPath: opts.optionsPath,
                // 与 in-page popup 同理：SW 侧按 sender.url 判 extpage 白名单，
                // 必须以扩展页 URL 身份发包
                senderPageUrl: "chrome-extension://" + opts.electronId + "/" + pagePath,
                // 锚定页 = tabs.query 的"当前页签"（真实源架构下必传，否则
                // AdGuard 的 tab 上下文塌成扩展页、弹窗端口回包永空）
                anchorTab: opts.anchorTab || null,
                manifestJson,
            };
            const out = await injectExtensionPageRuntime({
                webview: vw,
                extPath: opts.extPath,
                electronId: opts.electronId,
                pagePath,
                // 原生加载时 location/存储是真语义，不伪装不垫片；但 DOM 重建恒开：
                // Electron 原生加载扩展页时主世界会先跑一遍页面脚本（实测 SiYuan
                // Clip：主世界 chrome.storage.sync 可用 → bootstrapPopup 成功渲染
                // 一套 UI），隔离世界重放第二遍就叠加成双份"发送到思源"。旧的
                // 重放前清理只洗 #root/#root-portal（VM 挂载点），body 直插挂载的
                // 扩展（Clip）洗不到。重建 body = 恒从页面初始静态状态重放（原生
                // <link> CSS 与 origin 级 localStorage 均不受影响）。
                rebuildDom: true,
                // about:blank 兜底路径仍需 location 伪装（原生加载时 location 是真语义，无需）
                spoofLocationUrl: nativeLoad ? undefined : "chrome-extension://" + opts.electronId + "/" + pagePath,
                lsSeed: nativeLoad ? null : readExtLsSeed(opts.electronId),
                begin: () => beginPopupWorld(vw, extInfo),
                evalJs: (src2, relPath) => {
                    const fakeUrl = "chrome-extension://" + opts.electronId + "/" + String(relPath).replace(/^\.\//, "");
                    const prefixed = "self.__sySetCurrentScript && self.__sySetCurrentScript(" + JSON.stringify(fakeUrl) + ");\n" + src2;
                    return evalPopupJs(vw, extInfo, prefixed).then((rr) => {
                        if (!rr.ok) throw new Error(rr.error);
                        return rr.value;
                    });
                },
            });
            if (!out.ok) {
                this.onErrorCb(`打开「${opts.name}」面板失败: ${out.error}`);
                this.close();
            } else {
                // popup 页原生扩展 API 补丁（主世界，扩展文档就位后）：
                // 1) 消费 lastError —— VM 面板经原生 chrome.tabs.sendMessage 通知页签，
                //    页签接收端在自建世界（原生 content script 已清空）→ 原生恒置
                //    lastError 无人读 → "Unchecked runtime.lastError: Receiving end
                //    does not exist" 刷屏（CDP 实测来源 popup/index.html）。包装
                //    callback 读掉 lastError，仅消告警不改语义（VM 自身已 catch）。
                //    注：打开瞬间的首帧调用在补丁前，漏 1-2 条属预期。
                // 2) 隐藏"快速安装"入口（menu-find：GreasyFork/OpenUserJS 按站点找脚本）。
                try {
                    await vw.executeJavaScript("(() => { try { if (self.__syPopupHostPatched) return 'done'; self.__syPopupHostPatched = 1; const wrap = (o, k) => { try { const orig = o && o[k]; if (typeof orig !== 'function' || orig.__syPatched) return; const w = function (...a) { for (let i = a.length - 1; i >= 0; i--) { if (typeof a[i] === 'function') { const cb = a[i]; a[i] = function (...ca) { try { void chrome.runtime.lastError; } catch (e) {} try { cb.apply(this, ca); } catch (e2) {} }; break; } } return orig.apply(this, a); }; w.__syPatched = 1; o[k] = w; } catch (e) {} }; if (self.chrome && chrome.tabs) wrap(chrome.tabs, 'sendMessage'); if (self.chrome && chrome.runtime) wrap(chrome.runtime, 'sendMessage'); const st = document.createElement('style'); st.textContent = '.menu-find{display:none !important}'; (document.head || document.documentElement).appendChild(st); return 'ok'; } catch (e) { return 'err:' + e.message; } })()", false);
                } catch {}
                // 宽度自适应：按 guest 内容实测宽度调面板（320-480 夹紧）。
                // 共享 overlay 下不同扩展面板自然宽度不同（VM=320、思源剪藏更宽），
                // 固定 320 会把宽面板压窄（"面板没显示全"）。延迟一拍等渲染稳定。
                setTimeout(() => {
                    void (async () => {
                        try {
                            if (!this.vw || !this.isOpenFor(opts.extId)) return;
                            const m = await this.vw.executeJavaScript("Math.ceil(Math.max(document.body ? document.body.scrollWidth : 0, document.documentElement ? document.documentElement.scrollWidth : 0))", false);
                            const w = Math.max(320, Math.min(480, Math.ceil(Number(m) || 0)));
                            if (w && Math.abs(w - popupW) > 2) {
                                popupW = w;
                                this.applySize();
                            }
                        } catch {}
                    })();
                }, 400);
            }
        } catch (e) {
            this.onErrorCb(`打开「${opts.name}」面板失败: ${e instanceof Error ? e.message : e}`);
            this.close();
        }
    }

    /** 数据迟到补拉：面板已打开但数据未就位（precache 落地晚于 open）时
     *  重载 popup 文档，让它重新 fetch BGDATA —— 列表无条件最终一致显示 */
    refreshForData(): void {
        if (!this.openExtId || !this.vw) return;
        try { this.vw.reload(); } catch {}
    }

    /** 关闭 = 隐藏 + 导航 about:blank（文档与世界销毁，进程温热） */
    close(): void {
        const extId = this.openExtId;
        this.openExtId = null;
        this.openRequested = false;
        this.stopDrainLoop();
        // 关闭瞬间可能仍有在途出箱条目（SW handler 异步完成晚于泵停止）：补两拍
        if (this.activeOpts?.electronId) {
            const eid = this.activeOpts.electronId;
            setTimeout(() => void this.drainOutboxOnce(eid), 2000);
            setTimeout(() => void this.drainOutboxOnce(eid), 5000);
        }
        if (this.navTimer) { clearTimeout(this.navTimer); this.navTimer = null; }
        if (!this.host) return;
        try {
            document.removeEventListener("mousedown", this.onOutsideRef, true);
            window.removeEventListener("keydown", this.onEscRef, true);
        } catch {}
        try {
            this.host.style.display = "none";
            this.docReady = false;
            // loadURL 强制真实导航（src 同值重指派会被去重，dom-ready 不触发）；
            // 死 guest 跳过导航（loadURL 只会抛 Invalid guestInstanceId）——
            // 元素留待下次 open 时 rebuildGuestIfDead 换新
            if (this.vw && this.guestAlive()) {
                const lp = this.vw.loadURL?.("about:blank");
                if (lp && typeof lp.catch === "function") lp.catch(() => {});
            }
        } catch {}
        if (extId) this.onClosedCb(extId);
    }

    /** 页签销毁：连 webview 一起移除 */
    destroy(): void {
        try {
            document.removeEventListener("mousedown", this.onOutsideRef, true);
            window.removeEventListener("keydown", this.onEscRef, true);
        } catch {}
        this.stopDrainLoop();
        if (this.navTimer) { clearTimeout(this.navTimer); this.navTimer = null; }
        try { this.host?.remove(); } catch {}
        this.host = null;
        this.vw = null;
        this.openExtId = null;
    }

    private onOutsideRef = (ev: MouseEvent) => {
        if (!this.isOpen()) return;
        const t = ev.target as HTMLElement | null;
        if (t && (this.host!.contains(t) || t.closest(".sy-ext-popup-overlay") || t.closest("[data-ext-id]"))) return;
        this.close();
    };
    private onEscRef = (ev: KeyboardEvent) => { if (this.isOpen() && ev.key === "Escape") this.close(); };

    /** 常驻监听（创建实例后调用一次）：点外部/Esc 关闭 */
    installGlobalListeners(): void {
        document.addEventListener("mousedown", this.onOutsideRef, true);
        window.addEventListener("keydown", this.onEscRef, true);
    }
}
