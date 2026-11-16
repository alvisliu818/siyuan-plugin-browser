import { fetchSyncPost, showMessage, openTab, openWindow } from "siyuan";
import type { BrowserSettings, IWebviewTag } from "../types";
import { AnnotationStore, type AnnotationPageInfo } from "../storage/annotationStore";
import annotationScriptSource from "../assets/annotationScript.js";

/**
 * 网页标注：选中文字 → 悬浮小气泡点「标注」→ 在思源生成/追加标注块。
 *
 * 文档存储结构：标注存放路径（设置）→ 网站域名 → 完整网页的标注文档。
 * 每条标注 = 文档末尾追加一个引述块（选中文字）+ 一个空段（批注内容，用户书写）；
 * 不选中内容直接标注 = 只追加一个带时间戳的段（页面级标注）。
 * 锚点信息（quote/前后文/URL）写在引述块的 custom-syann 自定义属性里，
 * 重新打开页面时按 SQL 取回并恢复高亮位置；鼠标悬浮高亮显示绑定的思源块内容。
 */
export interface AnnCreatePayload {
    quote?: string;
    prefix?: string;
    suffix?: string;
    color?: string;
}

/** 传给页内脚本的标注项 */
interface AnnItem {
    id: string;
    quote: string;
    prefix: string;
    suffix: string;
    /** 绑定的思源块文本（引述块自身/其后批注段） */
    note: string;
    created: number;
    /** 批注内容块 id（引述块后的空段；用户编辑落点）。旧版标注可能缺失 */
    noteId?: string;
    /** 锚点块 id（引述块/段落本身） */
    anchorBlockId?: string;
    /** 高亮颜色（yellow/green/blue/pink/purple） */
    color?: string;
    /** 标签 */
    tags?: string[];
}

function htmlUnescape(s: string): string {
    return String(s)
        .replace(/&#123;/g, "{")
        .replace(/&#125;/g, "}")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

function joinPath(...parts: string[]): string {
    const joined = ("/" + parts.filter(Boolean).join("/")).replace(/\/{2,}/g, "/");
    return joined.length > 1 ? joined.replace(/\/+$/, "") : "/";
}

function pad2(n: number): string {
    return n < 10 ? "0" + n : "" + n;
}

/**
 * 标注 UI 样式：必须走 webview.insertCSS（宿主侧注入，不受页面 CSP 约束）。
 * 部分站点用 meta CSP 禁内联 <style>/style 属性，页内脚本注入的样式会整段
 * 失效——表现为弹框变成普通 div 追加到页面底部（页面流布局）。
 */
const ANN_CSS = `
.sy-ann-hl{position:relative;background:rgba(255,213,0,.4)!important;border-radius:2px;cursor:pointer;box-decoration-break:clone;-webkit-box-decoration-break:clone;}
.sy-ann-hl:hover{background:rgba(255,170,0,.6)!important;}
.sy-ann-bubble{position:fixed!important;z-index:2147483645;display:flex;align-items:center;gap:2px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.22);padding:3px;font-family:sans-serif;}
.sy-ann-bubble button{border:none;background:transparent;cursor:pointer;font-size:12px;padding:3px 10px;border-radius:4px;line-height:16px;}
.sy-ann-bubble .sy-ann-create{background:#1a73e8;color:#fff;font-weight:600;}
.sy-ann-pop{position:fixed!important;z-index:2147483645;max-width:340px;max-height:260px;overflow:auto;background:#fff;color:#222;border:none!important;outline:none;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.18);padding:10px 12px;font-size:13px;line-height:1.5;font-family:sans-serif;word-break:break-word;}
.sy-ann-pop-quote{font-size:12px;color:#666;border-left:3px solid #f5c542;padding-left:8px;margin-bottom:6px;white-space:pre-wrap;}
.sy-ann-pop-note{white-space:pre-wrap;}
.sy-ann-pop-empty{color:#999;font-style:italic;}
.sy-ann-pop-meta{margin-top:6px;font-size:11px;color:#aaa;}
.sy-ann-inline{position:absolute;left:0;top:100%;display:block;font-size:11px;color:#8a6d1a;background:none;border-radius:0;padding:0;margin:1px 0 0;cursor:pointer;line-height:1.2;white-space:nowrap;z-index:5;}
.sy-ann-inline:hover{opacity:.15;}
.sy-ann-c-yellow{background:rgba(255,213,0,.4)!important;}
.sy-ann-c-green{background:rgba(120,220,120,.45)!important;}
.sy-ann-c-blue{background:rgba(120,180,255,.45)!important;}
.sy-ann-c-pink{background:rgba(255,150,200,.45)!important;}
.sy-ann-c-purple{background:rgba(190,140,255,.45)!important;}
.sy-ann-swatches{display:flex;gap:4px;align-items:center;margin:6px 0;}
.sy-ann-sw{width:16px;height:16px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;}
.sy-ann-sw.on{border-color:#333;}
.sy-ann-sw-yellow{background:rgba(255,213,0,.9);}
.sy-ann-sw-green{background:rgba(120,220,120,.9);}
.sy-ann-sw-blue{background:rgba(120,180,255,.9);}
.sy-ann-sw-pink{background:rgba(255,150,200,.9);}
.sy-ann-sw-purple{background:rgba(190,140,255,.9);}
.sy-ann-tags{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0;}
.sy-ann-tag{font-size:11px;background:#eef;border-radius:3px;padding:1px 6px;cursor:pointer;color:#335;}
.sy-ann-taginput{font-size:12px;border:1px solid #ddd;border-radius:4px;padding:2px 6px;width:110px;}
.sy-ann-pop-actions{margin-top:8px;display:flex;gap:6px;justify-content:flex-end;}
.sy-ann-pop-actions button{border:1px solid #ddd;background:#f7f7f7;border-radius:4px;font-size:12px;padding:2px 8px;cursor:pointer;}
.sy-ann-pop-bar{display:flex;align-items:center;gap:4px;margin:-4px -4px 6px;padding:2px 4px;cursor:move;user-select:none;}
.sy-ann-pop-bar .t{flex:1;font-size:11px;color:#999;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
.sy-ann-pop-bar button{border:none;background:transparent;cursor:pointer;font-size:13px;padding:1px 5px;border-radius:4px;color:#666;}
.sy-ann-pop-bar button:hover{background:#eee;}
.sy-ann-pop-bar button.on{color:#1a73e8;background:#dbeafe;}
.sy-ann-pop-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;}
@keyframes syAnnFlash{0%{background:rgba(255,160,0,.9);}100%{background:rgba(255,213,0,.4);}}
.sy-ann-flash{animation:syAnnFlash 1.8s ease-out;}
`;

export class AnnotationController {
    /** 本会话已加载的页面标注缓存（urlKey → 标注列表），供点击弹框快速取用 */
    private pageCache = new Map<string, AnnItem[]>();
    private popupUrl: string | null = null;
    /** urlKey → webview，供元数据变更后回刷页内高亮/小字 */
    private webviews = new Map<string, IWebviewTag>();
    /** 标注 id → 浮动窗（复用，避免悬浮/点击重复弹窗） */
    private floatWins = new Map<string, any>();
    private floatChannel: BroadcastChannel | null = null;

    constructor(
        private store: AnnotationStore,
        private i18n: Record<string, string>,
        private getSettings: () => BrowserSettings,
    ) {
        // 轻量浮动窗（独立 OS 窗）经 BroadcastChannel 回传颜色/标签/编辑请求
        try {
            this.floatChannel = new BroadcastChannel("sy-ann-float");
            this.floatChannel.onmessage = (ev: MessageEvent) => {
                const m: any = ev.data;
                if (!m) return;
                if (m.type === "meta" && m.id) void this.applyMeta({ id: m.id, color: m.color, tags: m.tags });
                else if (m.type === "edit" && m.id) void this.openEditById(String(m.id));
                else if (m.type === "goto" && m.id) this.gotoAnnotation(String(m.id), String(m.url || ""));
                else if (m.type === "createPage") this.createPageFromFloat(String(m.url || ""));
                else if (m.type === "openDoc") void this.openDoc(String(m.url || ""));
                else if (m.id && (m.type === "pin" || m.type === "hide" || m.type === "resize" || m.type === "close")) {
                    const w = this.floatWins.get(String(m.id));
                    if (!w || w.isDestroyed()) return;
                    if (m.type === "pin") w.setAlwaysOnTop(!!m.value);
                    else if (m.type === "hide") w.hide();
                    else if (m.type === "resize") w.setSize(Number(m.w) || 380, Number(m.h) || 340);
                    else if (m.type === "close") w.close();
                }
            };
        } catch {}
    }

    /** 跨页缓存按 id 找标注项及其 urlKey */
    private findItem(id: string): { urlKey: string; item: AnnItem } | null {
        for (const [urlKey, items] of this.pageCache) {
            const item = items.find((i) => i.id === id);
            if (item) return { urlKey, item };
        }
        return null;
    }

    /** 页内小窗/浮动窗改颜色或标签 → 持久化到锚点 custom-syann 并回刷页内 */
    async applyMeta(payload: { id?: string; color?: string; tags?: string[] }): Promise<void> {
        try {
            const found = this.findItem(String(payload?.id || ""));
            if (!found) return;
            const { urlKey, item } = found;
            if (payload.color) item.color = payload.color;
            if (Array.isArray(payload.tags)) item.tags = payload.tags;
            const page = this.store.find(urlKey);
            if (!page?.docId || !item.anchorBlockId) return;
            const json = JSON.stringify({
                id: item.id, url: urlKey, quote: item.quote, prefix: item.prefix,
                suffix: item.suffix, created: item.created, noteId: item.noteId,
                color: item.color || "yellow", tags: item.tags || [],
            });
            await fetchSyncPost("/api/attr/setBlockAttrs", { id: item.anchorBlockId, attrs: { "custom-syann": json } });
            const wv = this.webviews.get(urlKey);
            if (wv) {
                wv.executeJavaScript("window.__syAnnSetNotes && window.__syAnnSetNotes(" + JSON.stringify([item]) + ");").catch(() => {});
            }
        } catch (e) {
            console.warn("[browser-plugin] annotation applyMeta failed:", e);
        }
    }

    /** 浮动窗「在思源编辑」：按 id 找批注块开原生 protyle 窗 */
    async openEditById(id: string): Promise<void> {
        const found = this.findItem(id);
        if (!found?.item.noteId) return;
        try {
            openWindow({ doc: { id: found.item.noteId }, width: 560, height: 480, alwaysOnTop: true });
        } catch (e) {
            console.warn("[browser-plugin] annotation openEdit failed:", e);
        }
    }

    /** 点击高亮 → 轻量浮动窗（独立 OS 窗：快、可多开、可拖出思源边界、可固定） */
    openFloat(webview: IWebviewTag, url: string, payload: { id?: string; x?: number; y?: number; hover?: boolean }): void {
        try {
            const urlKey = AnnotationStore.normalizeKey(url);
            this.webviews.set(urlKey, webview);
            const found = this.findItem(String(payload?.id || ""));
            const item = found?.item;
            if (!item) return;
            const data = {
                id: item.id, quote: item.quote, note: item.note,
                color: item.color || "yellow", tags: item.tags || [], url,
                hover: !!payload?.hover,
            };
            const remote = (window as any).require?.("@electron/remote");
            if (!remote?.BrowserWindow) return;
            // 光标处屏幕坐标（guest 视口坐标 + webview 偏移 + 宿主窗口屏幕位置）
            const wr = webview.getBoundingClientRect();
            const sx = Math.max(0, Math.min(Math.round(window.screenX + wr.left + (payload?.x || 0) + 12), (window.screen.availWidth || 1920) - 390));
            const sy = Math.max(0, Math.min(Math.round(window.screenY + wr.top + (payload?.y || 0) + 12), (window.screen.availHeight || 1080) - 350));
            const exist = this.floatWins.get(item.id);
            if (exist && !exist.isDestroyed()) {
                exist.__syAutoHide = !!payload?.hover;
                this.floatChannel?.postMessage({ type: "autohide", id: item.id, value: !!payload?.hover });
                exist.setPosition(sx, sy);
                exist.show();
                exist.focus();
                return;
            }
            const base = window.location.origin + "/plugins/" + ((window as any).browserPlugin?.name || "siyuan-plugin-browser") + "/";
            const win = new remote.BrowserWindow({
                width: 380, height: 340, x: sx, y: sy,
                frame: true, titleBarStyle: "hidden", resizable: true,
                alwaysOnTop: false, skipTaskbar: true,
                webPreferences: { nodeIntegration: true, contextIsolation: false },
            });
            win.__syAutoHide = !!payload?.hover;
            this.floatWins.set(item.id, win);
            win.on("closed", () => this.floatWins.delete(item.id));
            win.loadURL(base + "annotation-popup.html#" + encodeURIComponent(JSON.stringify(data)));
        } catch (e) {
            console.warn("[browser-plugin] annotation openFloat failed:", e);
        }
    }

    /** 鼠标离开高亮 → 通知悬浮浮动窗（未固定且鼠标不在窗内时自动收起） */
    notifyMarkLeave(id: string): void {
        this.floatChannel?.postMessage({ type: "markleave", id });
    }

    /** 地址栏 ✎ 菜单「本页标注列表」→ 轻量浮动窗列出本页全部标注（可固定、点条目跳转） */
    async openListFloat(webview: IWebviewTag, url: string): Promise<void> {
        try {
            if (!/^https?:\/\//i.test(url)) return;
            const urlKey = AnnotationStore.normalizeKey(url);
            this.webviews.set(urlKey, webview);
            let items = this.pageCache.get(urlKey);
            const page = this.store.find(urlKey);
            if (!items && page?.docId) items = await this.fetchAnnotations(page.docId);
            const listKey = "list:" + urlKey;
            const data = {
                mode: "list", url, listKey,
                items: (items || []).map((i) => ({ id: i.id, quote: i.quote, note: i.note, color: i.color || "yellow", tags: i.tags || [] })),
            };
            const remote = (window as any).require?.("@electron/remote");
            if (!remote?.BrowserWindow) return;
            const exist = this.floatWins.get(listKey);
            if (exist && !exist.isDestroyed()) {
                exist.show();
                exist.focus();
                return;
            }
            const base = window.location.origin + "/plugins/" + ((window as any).browserPlugin?.name || "siyuan-plugin-browser") + "/";
            const win = new remote.BrowserWindow({
                width: 400, height: 440, frame: true, titleBarStyle: "hidden", resizable: true, skipTaskbar: true,
                webPreferences: { nodeIntegration: true, contextIsolation: false },
            });
            this.floatWins.set(listKey, win);
            win.on("closed", () => this.floatWins.delete(listKey));
            win.loadURL(base + "annotation-popup.html#" + encodeURIComponent(JSON.stringify(data)));
        } catch (e) {
            console.warn("[browser-plugin] annotation openListFloat failed:", e);
        }
    }

    /** 设置开关变更后回刷各页内小字显隐（show 显式传新鲜值，避免缓存 settings 滞后） */
    applyInlineVisibility(show?: boolean): void {
        const v = show === undefined ? !!this.getSettings().showAnnInline : !!show;
        for (const wv of this.webviews.values()) {
            wv.executeJavaScript("window.__syAnnSetInlineVisible && window.__syAnnSetInlineVisible(" + JSON.stringify(v) + ");").catch(() => {});
        }
    }

    /** 列表浮动窗点条目 → 页内滚动到对应高亮并闪烁 */
    private gotoAnnotation(id: string, url: string): void {
        const wv = this.webviews.get(AnnotationStore.normalizeKey(url));
        if (!wv) return;
        wv.executeJavaScript("window.__syAnnFocused=null; window.__syAnnFocus && window.__syAnnFocus(" + JSON.stringify(id) + ");").catch(() => {});
    }

    /** 列表浮动窗「标注此页」→ 页面级标注 */
    private createPageFromFloat(url: string): void {
        const wv = this.webviews.get(AnnotationStore.normalizeKey(url));
        if (!wv) return;
        const title = String((wv as any).getTitle?.() || "");
        void this.create(wv, url, title, {});
    }

    /** dom-ready 注入页内脚本并恢复本页标注高亮 */
    async onPageReady(webview: IWebviewTag, url: string, title: string): Promise<void> {
        try {
            if (!/^https?:\/\//i.test(url)) return;
            let items: AnnItem[] = [];
            const urlKey = AnnotationStore.normalizeKey(url);
            const page = this.store.find(urlKey);
            if (page?.docId) {
                items = await this.fetchAnnotations(page.docId);
            }
            this.pageCache.set(urlKey, items);
            this.webviews.set(urlKey, webview);
            const script = annotationScriptSource + "\nwindow.__syAnnInit(" + JSON.stringify(items) + "," + JSON.stringify(!!this.getSettings().showAnnInline) + ");";
            // 样式必须先于脚本经 insertCSS 注入（不受页面 meta CSP 限制）；
            // 页内 ensureStyle 只作兜底
            try {
                await webview.insertCSS(ANN_CSS);
            } catch (e) {
                console.warn("[browser-plugin] annotation insertCSS failed:", e);
            }
            await webview.executeJavaScript(script);
            // 回到页签（如从思源编辑窗切回）时刷新批注文本，内联小字/小窗保持最新
            if (!(webview as any).__syAnnNoteHook) {
                (webview as any).__syAnnNoteHook = true;
                webview.addEventListener("focus", () => void this.refreshNotes(webview));
            }
            // SPA/懒加载正文晚于 dom-ready 渲染：补画两轮（已包裹的标注不会重复包裹）
            for (const delay of [2000, 5000]) {
                setTimeout(() => {
                    webview.executeJavaScript("window.__syAnnRender && window.__syAnnRender()").catch(() => {});
                }, delay);
            }
            // 从标注文档链接跳转而来（url 带 #syann=<id>）：滚动到对应高亮；
            // 高亮渲染时点不定（懒加载），按间隔重试，页内脚本成功后自动置闩
            const focusId = AnnotationController.extractFocusId(url);
            if (focusId) {
                for (const delay of [600, 1600, 3200, 6500, 10000]) {
                    setTimeout(() => {
                        webview.executeJavaScript("window.__syAnnFocus && window.__syAnnFocus(" + JSON.stringify(focusId) + ");").catch(() => {});
                    }, delay);
                }
            }
        } catch (e) {
            console.warn("[browser-plugin] annotation inject failed:", e);
        }
    }

    /** 重拉本页批注并刷新页内内联小字/缓存（编辑后切回页签时调用） */
    private async refreshNotes(webview: IWebviewTag): Promise<void> {
        try {
            const url = String((webview as any).getURL?.() || "");
            if (!/^https?:\/\//i.test(url)) return;
            const urlKey = AnnotationStore.normalizeKey(url);
            const page = this.store.find(urlKey);
            if (!page?.docId) return;
            const items = await this.fetchAnnotations(page.docId);
            this.pageCache.set(urlKey, items);
            await webview.executeJavaScript("window.__syAnnSetNotes && window.__syAnnSetNotes(" + JSON.stringify(items) + ");");
        } catch {}
    }

    /** 从 URL 提取标注定位片段（#syann=<标注id>） */
    static extractFocusId(url: string): string {
        const m = /#syann=([\w-]+)/.exec(url || "");
        return m ? m[1] : "";
    }

    /** 创建一条标注（quote 为空 = 页面级标注），落库到思源并回填页内高亮 */
    async create(webview: IWebviewTag, url: string, title: string, payload: AnnCreatePayload): Promise<void> {
        const i18n = this.i18n;
        try {
            if (!/^https?:\/\//i.test(url)) return;
            const s = this.getSettings();
            if (!s.annotationNotebook) {
                showMessage(i18n.annotationNotebookRequired || "请先在插件设置中选择标注保存笔记本", 4000, "error");
                return;
            }
            const urlKey = AnnotationStore.normalizeKey(url);
            const quote = String(payload?.quote || "").replace(/\s+/g, " ").trim().slice(0, 2000);
            let page = this.store.find(urlKey);
            if (!page) {
                page = await this.ensurePageDoc(url, urlKey, title, s);
            }
            if (!page) return;

            const now = Date.now();
            const annId = "ann-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
            const d = new Date();
            const stamp = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
            // 标注块 = 思源里的链接：点击跳回原网页。
            // - 有选区：引述块，链接带 #syann=<id> 片段，打开网页后自动滚动到标注高亮；
            // - 无选区：页面级标注，块内容即网页链接，点击打开网页。
            const annUrl = url + "#syann=" + annId;
            const escMd = (t: string) => t.replace(/([\[\]])/g, "\\$&");
            // 大纲式结构，一次插入两级 markdown（避免插入后查询的竞态）：
            //   - [选中文字](链接)     ← 列表项锚点（custom-syann）
            //       - （批注）          ← 子列表项（noteId，随后清空占位）
            const anchorMd = quote
                ? "- [" + escMd(quote) + "](" + annUrl + ")\n    - （批注）"
                : "- [" + escMd(this.safeTitle(title || url)) + "](" + url + ") - " + stamp + "\n    - （批注）";
            const ins: any = await fetchSyncPost("/api/block/insertBlock", {
                parentID: page.docId,
                dataType: "markdown",
                data: anchorMd,
            });
            if (ins?.code !== 0) throw new Error(ins?.msg || "insertBlock failed");
            // 从返回的 DOM（ops[0].data）里按 data-type 解析各层级块 id，确定性取 id
            const ops = (Array.isArray(ins.data) ? ins.data : [ins.data])[0]?.doOperations || [];
            const html = String(ops[0]?.data || "");
            const tagRe = /<div\b([^>]*)>/g;
            const byType: Record<string, string[]> = {};
            let mm: RegExpExecArray | null;
            while ((mm = tagRe.exec(html))) {
                const nid = /data-node-id="([^"]+)"/.exec(mm[1]);
                const dt = /data-type="([^"]+)"/.exec(mm[1]);
                if (nid && dt) {
                    (byType[dt[1]] = byType[dt[1]] || []).push(nid[1]);
                }
            }
            const listId = (byType["NodeList"] || [])[0] || "";
            const itemsInList = byType["NodeListItem"] || [];
            const anchorId = itemsInList[0] || listId;
            const noteItemBlockId = itemsInList[1] || "";
            if (!anchorId) throw new Error("未返回标注块 id");
            // 占位清空（保留空列表项，类似 Logseq 新建 bullet）；
            // 列表项必须用列表语法更新，data:" " 会被内核忽略
            if (noteItemBlockId) {
                fetchSyncPost("/api/block/updateBlock", { id: noteItemBlockId, dataType: "markdown", data: "- " }).catch(() => {});
            }
            const color = String(payload?.color || "yellow");
            const anchorJson = JSON.stringify({
                id: annId,
                url: urlKey,
                quote,
                prefix: String(payload?.prefix || "").slice(0, 60),
                suffix: String(payload?.suffix || "").slice(0, 60),
                created: now,
                noteId: noteItemBlockId,
                color,
                tags: [],
            });
            await fetchSyncPost("/api/attr/setBlockAttrs", { id: anchorId, attrs: { "custom-syann": anchorJson } });
            await this.store.upsert(urlKey, page);
            if (quote) {
                const item: AnnItem = {
                    id: annId,
                    quote,
                    prefix: String(payload?.prefix || "").slice(0, 60),
                    suffix: String(payload?.suffix || "").slice(0, 60),
                    note: "",
                    created: now,
                    noteId: noteItemBlockId || undefined,
                    anchorBlockId: anchorId,
                    color,
                    tags: [],
                };
                webview.executeJavaScript("window.__syAnnApply && window.__syAnnApply(" + JSON.stringify([item]) + ");").catch(() => {});
            }
            showMessage(i18n.annotationCreated || "已标注", 2000, "info");
        } catch (e: any) {
            console.warn("[browser-plugin] annotation create failed:", e);
            showMessage((i18n.annotationFailed || "标注失败") + ": " + (e?.message || e), 4000, "error");
        }
    }

    /** 打开当前页面的标注文档 */
    async openDoc(url: string): Promise<void> {
        const page = this.store.find(AnnotationStore.normalizeKey(url));
        if (!page?.docId) {
            showMessage(this.i18n.annotationNoDoc || "当前页面还没有标注文档", 3000, "info");
            return;
        }
        try {
            const plugin = (window as any).browserPlugin;
            openTab({ app: plugin?.app, doc: { id: page.docId, action: [] } } as any);
        } catch (e) {
            console.warn("[browser-plugin] open annotation doc failed:", e);
        }
    }

    /**
     * 点击页内高亮 → 思源原生独立窗口（openWindow）打开批注块。
     * 窗内为原生 protyle，直接编辑、自动保存；窗口可拖动、可多开、置顶。
     */
    async showDialog(webview: IWebviewTag, url: string, payload: { id?: string; x?: number; y?: number }): Promise<void> {
        try {
            const urlKey = AnnotationStore.normalizeKey(url);
            let items = this.pageCache.get(urlKey);
            if (!items) {
                const page = this.store.find(urlKey);
                if (!page?.docId) return;
                items = await this.fetchAnnotations(page.docId);
                this.pageCache.set(urlKey, items);
            }
            const ann = items.find((i) => i.id === String(payload?.id || ""));
            if (!ann) {
                showMessage(this.i18n.annotationNoDoc || "当前页面还没有标注文档", 3000, "info");
                return;
            }
            const page = this.store.find(urlKey);

            // 旧版标注缺批注块：懒补一个（引述标注取锚点后同级段；页面级新建空段）
            if (!ann.noteId && page?.docId) {
                if (ann.quote && ann.anchorBlockId) {
                    try {
                        const q: any = await fetchSyncPost("/api/query/sql", {
                            stmt: "SELECT id FROM blocks WHERE root_id='" + page.docId + "' AND parent_id='" + page.docId
                                + "' AND type='p' AND sort > (SELECT sort FROM blocks WHERE id='" + ann.anchorBlockId + "') LIMIT 1",
                        });
                        ann.noteId = String(q?.data?.[0]?.id || "");
                    } catch {}
                    // 旧数据 sort 顺序异常（批注段排在引述块前）时：回退到「顶层无
                    // 标注属性的空段」
                    if (!ann.noteId) {
                        try {
                            const q2: any = await fetchSyncPost("/api/query/sql", {
                                stmt: "SELECT id FROM blocks WHERE root_id='" + page.docId + "' AND parent_id='" + page.docId
                                    + "' AND type='p' AND content='' AND ial NOT LIKE '%custom-syann%' AND id != '"
                                    + ann.anchorBlockId + "' LIMIT 1",
                            });
                            ann.noteId = String(q2?.data?.[0]?.id || "");
                        } catch {}
                    }
                } else {
                    try {
                        const ins: any = await fetchSyncPost("/api/block/insertBlock", {
                            parentID: page.docId, dataType: "markdown", data: " ",
                        });
                        const n0 = Array.isArray(ins?.data) ? ins.data[0] : ins?.data;
                        ann.noteId = typeof n0 === "string" ? n0 : String(n0?.doOperations?.[0]?.id || "");
                    } catch {}
                }
                if (ann.noteId && ann.anchorBlockId) {
                    fetchSyncPost("/api/attr/setBlockAttrs", {
                        id: ann.anchorBlockId,
                        attrs: { "custom-syann": JSON.stringify({
                            id: ann.id, url: urlKey, quote: ann.quote, prefix: ann.prefix,
                            suffix: ann.suffix, created: ann.created, noteId: ann.noteId,
                        }) },
                    }).catch(() => {});
                }
            }

            if (!ann.noteId) {
                showMessage(this.i18n.annotationNoDoc || "缺少批注块", 3000, "error");
                return;
            }
            // 思源原生独立窗口打开批注块（protyle 直接编辑、自动保存）。
            // 屏幕坐标 = 宿主窗口屏幕位置 + webview 视口偏移 + 页内点击坐标。
            const width = 560;
            const height = 480;
            const wr = webview.getBoundingClientRect();
            let x = Math.round(window.screenX + wr.left + (payload?.x || 0) + 14);
            let y = Math.round(window.screenY + wr.top + (payload?.y || 0) - 24);
            x = Math.min(Math.max(x, 0), window.screen.availWidth - width);
            y = Math.min(Math.max(y, 0), window.screen.availHeight - height);
            openWindow({
                doc: { id: ann.noteId },
                width,
                height,
                position: { x, y },
                alwaysOnTop: true,
            });
        } catch (e) {
            console.warn("[browser-plugin] annotation editor window failed:", e);
        }
    }

    /** 定位/创建页面标注文档（存放路径 → 域名 → 页面标题） */
    private async ensurePageDoc(url: string, urlKey: string, title: string, s: BrowserSettings): Promise<AnnotationPageInfo | null> {
        let domain = "";
        try { domain = new URL(url).hostname; } catch {}
        const docTitle = this.safeTitle(title || domain || urlKey);
        const parentPath = (s.annotationParentPath || "/网页标注").trim() || "/网页标注";
        const hpath = joinPath(parentPath, domain, docTitle);
        // 先查同路径文档（createDocWithMd 对已存在路径会报错）
        let docId = "";
        try {
            const q: any = await fetchSyncPost("/api/query/sql", {
                stmt: "SELECT root_id FROM blocks WHERE box='" + s.annotationNotebook.replace(/'/g, "''")
                    + "' AND hpath='" + hpath.replace(/'/g, "''") + "' AND type='d' LIMIT 1",
            });
            docId = String(q?.data?.[0]?.root_id || "");
        } catch {}
        if (!docId) {
            const d = new Date();
            const md = "- [来源](" + url + ")\n- 创建于 " + d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
            const r: any = await fetchSyncPost("/api/filetree/createDocWithMd", {
                notebook: s.annotationNotebook,
                path: hpath,
                markdown: md,
            });
            if (r?.code !== 0) {
                showMessage((this.i18n.annotationFailed || "标注失败") + ": " + (r?.msg || "createDoc"), 4000, "error");
                return null;
            }
            docId = String(r.data);
        }
        const info: AnnotationPageInfo = { docId, title: docTitle, domain, createdAt: Date.now() };
        await this.store.upsert(urlKey, info);
        return info;
    }

    /** 从标注文档取回全部标注锚点（custom-syann 存在锚点块的自定义属性里） */
    private async fetchAnnotations(docId: string): Promise<AnnItem[]> {
        try {
            // 全量取回文档块（新结构锚点=列表项 i，批注=其子块；旧结构=引述 b/段落 p）
            const r: any = await fetchSyncPost("/api/query/sql", {
                stmt: "SELECT id, type, content, ial, parent_id FROM blocks WHERE root_id='" + docId + "' ORDER BY sort",
            });
            const rows: any[] = r?.data || [];
            const items: AnnItem[] = [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const m = /custom-syann="([^"]*)"/.exec(String(row.ial || ""));
                if (!m) continue;
                let anchor: any;
                try { anchor = JSON.parse(htmlUnescape(m[1])); } catch { continue; }
                if (!anchor || typeof anchor !== "object") continue;
                let note = "";
                let noteId = String(anchor.noteId || "");
                if (row.type === "i") {
                    // 新结构：批注 = 锚点列表项下嵌套列表的列表项
                    const nestedL = rows.find((c) => c.parent_id === row.id && c.type === "l");
                    const noteRow = nestedL ? rows.find((c) => c.parent_id === nestedL.id) : null;
                    if (noteRow) {
                        note = String(noteRow.content || "");
                        if (!noteId) noteId = String(noteRow.id || "");
                    }
                } else if (row.type === "b") {
                    // 旧结构：引述块锚点 → 其后的同级空段是批注内容
                    const nxt = rows[i + 1];
                    if (nxt && nxt.parent_id === row.parent_id && nxt.type === "p" && !/custom-syann=/.test(String(nxt.ial || ""))) {
                        note = String(nxt.content || "");
                        if (!noteId) noteId = String(nxt.id || "");
                    }
                } else if (row.type === "p") {
                    // 旧结构页面级：锚点段落自身即批注
                    note = String(row.content || "");
                }
                items.push({
                    id: String(anchor.id || row.id),
                    quote: String(anchor.quote || ""),
                    prefix: String(anchor.prefix || ""),
                    suffix: String(anchor.suffix || ""),
                    note,
                    created: Number(anchor.created) || 0,
                    noteId: noteId || undefined,
                    anchorBlockId: String(row.id || ""),
                    color: String(anchor.color || "yellow"),
                    tags: Array.isArray(anchor.tags) ? anchor.tags.map(String) : [],
                });
            }
            return items;
        } catch (e) {
            console.warn("[browser-plugin] fetchAnnotations failed:", e);
            return [];
        }
    }

    /** 文档标题清洗（SiYuan 路径段不允许 / \ 等） */
    private safeTitle(t: string): string {
        let s = String(t || "").replace(/[\\/:*?"<>|#]/g, " ").replace(/\s+/g, " ").trim();
        if (!s) s = "未命名页面";
        return s.slice(0, 60);
    }
}
