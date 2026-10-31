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
import { injectExtensionPageRuntime } from "./ext-popup";
import { beginPopupWorld, evalPopupJs, ICsExtInfo } from "../extensions/cs-runtime";

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
    userAgent?: string;
    onError: (msg: string) => void;
}

const POPUP_W = 360;
const POPUP_H = 520;

export class ExtensionPopupOverlay {
    private tabRoot: HTMLElement;
    private host: HTMLElement | null = null;
    private vw: IWebviewTag | null = null;
    private userAgent: string | undefined;
    private openExtId: string | null = null;   // 当前打开的扩展（null = 无 popup 显示）
    private openRequested = false;             // 已请求注入（等 dom-ready）
    private docReady = false;                  // guest 文档就绪（about:blank 加载完成）
    private activeOpts: PopupOpenOptions | null = null;
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
        host.style.cssText = `position:fixed;z-index:2147483000;width:${POPUP_W}px;height:${POPUP_H}px;display:none;`
            + `background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.28);`;
        const vw = document.createElement("webview") as unknown as IWebviewTag;
        vw.setAttribute("src", "about:blank");
        vw.setAttribute("partition", BROWSER_PARTITION);
        // 与页面 webview 同偏好（禁沙箱世界语义一致）；不挂 preload（弹窗不需要链接拦截）
        vw.setAttribute("webpreferences", "contextIsolation=no,nodeIntegrationInSubFrames=yes");
        if (this.userAgent) {
            try { vw.useragent = this.userAgent; } catch {}
        }
        vw.style.cssText = "width:100%;height:100%;border:0;";
        host.appendChild(vw);
        vw.addEventListener("dom-ready", () => {
            this.docReady = true;
            if (this.openRequested) void this.injectNow();
        });
        vw.addEventListener("crashed", () => {
            // 崩溃后重建 guest：回 about:blank 重新走加载
            try { vw.setAttribute("src", "about:blank"); } catch {}
            this.docReady = false;
        });
        this.tabRoot.appendChild(host);
        this.host = host;
        this.vw = vw;
    }

    private applyUserAgent(ua?: string): void {
        if (!ua || !this.vw) return;
        try { this.vw.useragent = ua; } catch {}
    }

    /** 打开（已开同一扩展 = no-op；已开其他扩展 = 切换文档） */
    open(opts: PopupOpenOptions): void {
        this.userAgent = opts.userAgent;
        this.ensureWarm();
        const sameDoc = this.openExtId === opts.extId && this.isOpenFor(opts.extId);
        this.activeOpts = opts;
        this.openExtId = opts.extId;
        // 定位：右缘对齐图标右缘，顶缘在图标下方；越界收回窗口内
        const a = opts.anchorRect;
        const left = Math.max(8, Math.min(a.right - POPUP_W, (window.innerWidth || 800) - POPUP_W - 8));
        const top = Math.max(8, Math.min(a.bottom + 6, (window.innerHeight || 600) - POPUP_H - 8));
        this.host!.style.left = left + "px";
        this.host!.style.top = top + "px";
        this.host!.style.display = "";
        if (this.userAgent) this.applyUserAgent(this.userAgent);
        if (sameDoc) return; // 同一扩展已显示（注入完成过）——保持现状
        // 全新文档注入：强制真实导航（loadURL 同值也导航，src 同值会被去重），
        // dom-ready 后注入
        this.openRequested = true;
        this.docReady = false;
        try { const lp = this.vw!.loadURL?.("about:blank"); if (lp && typeof lp.catch === "function") lp.catch(() => {}); } catch { try { this.vw!.src = "about:blank"; } catch {} }
        // 同 URL 导航会被 Chromium 去重（无 dom-ready）→ reload 强制新文档
        try { this.vw!.reload(); } catch {}
    }

    private async injectNow(): Promise<void> {
        const opts = this.activeOpts;
        const vw = this.vw;
        if (!opts || !vw || !this.openRequested) return;
        this.openRequested = false;
        try {
            const pagePath = String(opts.popupPath).replace(/^\.\//, "");
            const extInfo: ICsExtInfo = {
                electronId: opts.electronId,
                path: opts.extPath,
                name: opts.name,
                version: opts.version,
                defaultLocale: opts.defaultLocale,
                contentScripts: opts.contentScripts,
                // 与 in-page popup 同理：SW 侧按 sender.url 判 extpage 白名单，
                // 必须以扩展页 URL 身份发包
                senderPageUrl: "chrome-extension://" + opts.electronId + "/" + pagePath,
            };
            const out = await injectExtensionPageRuntime({
                webview: vw,
                extPath: opts.extPath,
                electronId: opts.electronId,
                pagePath,
                spoofLocationUrl: "chrome-extension://" + opts.electronId + "/" + pagePath,
                rebuildDom: true,
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
            }
        } catch (e) {
            this.onErrorCb(`打开「${opts.name}」面板失败: ${e instanceof Error ? e.message : e}`);
            this.close();
        }
    }

    /** 关闭 = 隐藏 + 导航 about:blank（文档与世界销毁，进程温热） */
    close(): void {
        const extId = this.openExtId;
        this.openExtId = null;
        this.openRequested = false;
        if (!this.host) return;
        try {
            document.removeEventListener("mousedown", this.onOutsideRef, true);
            window.removeEventListener("keydown", this.onEscRef, true);
        } catch {}
        try {
            this.host.style.display = "none";
            this.docReady = false;
            // loadURL 强制真实导航（src 同值重指派会被去重，dom-ready 不触发）
            if (this.vw) { const lp = this.vw.loadURL?.("about:blank"); if (lp && typeof lp.catch === "function") lp.catch(() => {}); }
        } catch {}
        if (extId) this.onClosedCb(extId);
    }

    /** 页签销毁：连 webview 一起移除 */
    destroy(): void {
        try {
            document.removeEventListener("mousedown", this.onOutsideRef, true);
            window.removeEventListener("keydown", this.onEscRef, true);
        } catch {}
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
