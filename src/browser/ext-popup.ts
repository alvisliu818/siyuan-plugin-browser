/**
 * 把扩展的 popup 面板注入到当前浏览的页面内展示。
 *
 * 为什么不在新标签里打开 popup.html：popup 的语义是"对当前页操作"，
 * 它靠 chrome.tabs.query({active:true}) 找目标页、再 tabs.sendMessage 发消息。
 * 单独开个标签加载 popup.html，"当前页"就成了它自己，消息永远到不了真正
 * 要操作的页面（实测 Eruda 的 Inject 按钮点了没反应就是这个原因）。
 *
 * 把 popup 的 HTML/CSS/JS 注入到目标页的 DOM 里执行就不一样了：
 * 执行上下文就是目标页本身，chrome.tabs.query 天然返回本页，
 * sendMessage 也能被本页的 content script 收到 —— 与真 Chrome 的
 * 弹窗行为一致。这也要求 webpreferences 是 contextIsolation=no
 * （本插件的 webview 正是如此），页面世界里才有 chrome 对象可用。
 */
import type { IWebviewTag } from "../types";

interface INodeMods {
    fs: typeof import("fs");
    path: typeof import("path");
}

function nodeMods(): INodeMods {
    const req = (window as any).require;
    if (!req) throw new Error("node require unavailable");
    return { fs: req("fs"), path: req("path") };
}

/** 读文本文件，不存在/读取失败返回 null */
function readText(fs: typeof import("fs"), p: string): string | null {
    try {
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p, "utf8");
    } catch {
        return null;
    }
}

/**
 * 把 html 里的相对资源引用改写为 chrome-extension:// 绝对地址。
 * 只处理常见的属性形态；popup 一般只引用同目录的 css/js/图标。
 */
function rewriteUrls(html: string, electronId: string): string {
    const base = `chrome-extension://${electronId}/`;
    return html
        // src="xxx"、href="xxx"、src='xxx'、href='xxx'（跳过已是绝对协议的）
        .replace(/(src|href)(\s*=\s*)(["'])(?!data:|https?:|chrome-extension:)([^"']+)\3/gi,
            (_m, attr, eq, q, url) => `${attr}${eq}${q}${base}${String(url).replace(/^\.\//, "")}${q}`);
}

/** CSS 里的相对 url(...) 绝对化（整页重建时样式全局生效，相对引用会打到
 *  about:blank 上 404）；忽略 data:/https?:/chrome-extension: 及 #hash 引用。 */
function rewriteCssUrls(css: string, electronId: string): string {
    const base = `chrome-extension://${electronId}/`;
    return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, url) => {
        const u = String(url).trim();
        if (!u || /^(data:|https?:|chrome-extension:|#)/i.test(u)) return m;
        return `url(${q}${base}${u.replace(/^\.\//, "")}${q})`;
    });
}

/**
 * 从完整 html 里取 <body>…</body> 的内容；没有 body 标签就整个返回。
 */
function extractBody(html: string): string {
    const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    return m ? m[1] : html;
}

/** 取 body 开标签上的属性串（class/id/style 等）——整页重建时需要原样保留 */
function extractBodyAttrs(html: string): string {
    const m = html.match(/<body([^>]*)>/i);
    return m ? m[1].trim() : "";
}

/** 取 <title> 文本 */
function extractTitle(html: string): string {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? m[1].trim() : "";
}

/** 收集 html 里 <script src> 引用的本地 js 文件相对路径 */
function collectScriptSrcs(html: string): Array<{ kind: "src" | "inline"; value: string }> {
    // 新标签页/选项页适配：除了外链 <script src>，内联脚本也要按文档顺序
    // 收集 —— 小型扩展（及手写页）用内联脚本调 chrome.*，漏掉即整页空转
    const out: Array<{ kind: "src" | "inline"; value: string }> = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        const attrs = m[1] || "";
        const body = m[2] || "";
        const srcMatch = attrs.match(/\ssrc\s*=\s*(["'])([^"']+)\1/i);
        if (srcMatch) out.push({ kind: "src", value: srcMatch[2] });
        else if (body.trim()) out.push({ kind: "inline", value: body });
    }
    return out;
}

/** 收集 html 里 <link rel=stylesheet> 引用的本地 css 文件相对路径 */
function collectCssHrefs(html: string): string[] {
    const out: string[] = [];
    const re = /<link[^>]*\srel\s*=\s*(["'])stylesheet\1[^>]*\shref\s*=\s*(["'])([^"']+)\2[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        out.push(m[3]);
    }
    // 属性顺序相反的写法（href 在 rel 前）
    const re2 = /<link[^>]*\shref\s*=\s*(["'])([^"']+)\1[^>]*\srel\s*=\s*(["'])stylesheet\3[^>]*>/gi;
    while ((m = re2.exec(html))) {
        if (!out.includes(m[2])) out.push(m[2]);
    }
    return out;
}

/**
 * popup 世界里先执行的前奏：
 * document.body 是 Chromium 的 Unforgeable 属性（defineProperty 覆盖不了），
 * 但每个 JS 世界的 DOM 包装对象相互独立 —— 在 popup 世界给 body 的挂载方法
 * 打补丁，popup JS 的 document.body.appendChild(...) 等会重定向进面板容器
 * （有样式、随面板关闭一起移除，不污染宿主页面）；面板不在时透传真实 body。
 * 只影响 popup 世界，页面主世界 / content 世界不受影响。
 */
/**
 * CSS 作用域重写（popup 世界注入版，经 fn.toString() 进 prelude）。
 * 必须是**自包含**的普通函数：模板字符串里写正则会遭打包器非法转义二次
 * cooking（实测 `\\*` 的反斜杠在 bundle 里丢失 → 注入代码语法错误），toString
 * 注入则零转义、打包器任意变换都不影响。禁止引用模块级状态。
 */

/** 宿主页 localStorage 上扩展存储的键前缀（localStorage 垫片持久化用） */
export function extLsHostKey(electronId: string): string {
    return "syExtLs::" + electronId;
}

/** 读扩展的 localStorage 种子（宿主页 → 模拟扩展文档）。坏数据返回 null。 */
export function readExtLsSeed(electronId: string): Record<string, string> | null {
    try {
        const raw = window.localStorage.getItem(extLsHostKey(electronId));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
    } catch {
        return null;
    }
}

/** 宿主页持久化扩展的 localStorage 快照（guest 垫片经 ipc 回灌时调用） */
export function persistExtLs(electronId: string, data: unknown): void {
    try {
        if (!electronId || !data || typeof data !== "object") return;
        window.localStorage.setItem(extLsHostKey(electronId), JSON.stringify(data));
    } catch {}
}

export function syScopeCssJs(css: string, scopeSel: string): string {
    const splitTop = (s: string): string[] => {
        const out: string[] = [];
        let depth = 0;
        let cur = "";
        for (const ch of s) {
            if (ch === "(" || ch === "[") depth++;
            else if (ch === ")" || ch === "]") depth--;
            if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
            else cur += ch;
        }
        if (cur.trim()) out.push(cur);
        return out.map((x) => x.trim()).filter(Boolean);
    };
    const reRoot = /(^|[\s>+~,])(html|body|:root)(?=[\s.#[{,:]|$)/gi;
    const reStar = /(^|[\s>+~,]|\b)\*(?=[\s.#[{,:]|$)/g;
    const mapSel = (sel: string): string => {
        return splitTop(sel).map((t) => {
            const replaced = t.replace(reRoot, (_m, pre) => pre + scopeSel);
            if (replaced !== t) return replaced;
            const star = t.replace(reStar, (_m, pre) => pre + scopeSel + " *");
            if (star !== t) return star;
            return scopeSel + " " + t;
        }).join(", ");
    };
    const walk = (src: string): string => {
        const out: string[] = [];
        let i = 0;
        while (i < src.length) {
            const brace = src.indexOf("{", i);
            if (brace < 0) break;
            const sel = src.slice(i, brace).trim();
            let depth = 1;
            let j = brace + 1;
            while (j < src.length && depth > 0) {
                if (src[j] === "{") depth++;
                else if (src[j] === "}") depth--;
                j++;
            }
            const body = src.slice(brace + 1, j - 1);
            i = j;
            if (/^@(keyframes|font-face|charset)/i.test(sel)) out.push(sel + "{" + body + "}");
            else if (/^@(media|supports|layer)/i.test(sel)) out.push(sel + "{" + walk(body) + "}");
            else out.push(mapSel(sel) + "{" + body + "}");
        }
        return out.join("\n");
    };
    return walk(String(css));
}

export const POPUP_JS_PRELUDE = `
(function () {
    if (window.__syExtPopupBodyHook) return;
    window.__syExtPopupBodyHook = true;
    // ★ localStorage/sessionStorage 垫片：模拟扩展文档跑在 about:blank（不透明
    //   源）上，原生 window.localStorage 访问直接抛 SecurityError —— 实测 AdGuard
    //   popup 的 React init 读 localStorage 崩溃 → 面板永不挂载（DevTools 才
    //   看得到的静默根因）。特征检测：仅当原生访问被拒时安装内存垫片（真实
    //   源文档不装、行为不变）。种子由宿主经 __syLsCtx 传入（宿主页 localStorage
    //   的 syExtLs::<extId>，"连宿主 localStorage"），写入防抖后经 preload 暴露的
    //   __syExtLsSend（仅 about:blank 主帧存在）回灌宿主持久化，关弹窗不丢。
    try {
        var __syLsOk = true;
        try { if (!window.localStorage || typeof window.localStorage.getItem !== "function") __syLsOk = false; } catch (eLsProbe) { __syLsOk = false; }
        if (!__syLsOk) {
            var __syMkStorage = function (seed, onWrite) {
                var d = {};
                try {
                    for (var k in seed) {
                        if (Object.prototype.hasOwnProperty.call(seed, k)) d[k] = String(seed[k]);
                    }
                } catch (e) {}
                var st = {
                    getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
                    setItem: function (k, v) { d[String(k)] = String(v); if (onWrite) onWrite(d); },
                    removeItem: function (k) { delete d[String(k)]; if (onWrite) onWrite(d); },
                    clear: function () { d = {}; if (onWrite) onWrite(d); },
                    key: function (i) { var ks = Object.keys(d); return i >= 0 && i < ks.length ? ks[i] : null; },
                };
                Object.defineProperty(st, "length", { configurable: true, get: function () { return Object.keys(d).length; } });
                return st;
            };
            var __syLsDict = null;      // localStorage 垫片的活字典（回灌快照源）
            var __syLsFlushT = null;
            var __syFlushLsNow = function () {
                if (!__syLsDict || !(typeof window.__syExtLsSend === "function") || !self.__syLsCtx || !self.__syLsCtx.extId) return;
                try { window.__syExtLsSend(self.__syLsCtx.extId, __syLsDict); } catch (e) {}
            };
            var __syFlushLsSoon = function () {
                if (__syLsFlushT) clearTimeout(__syLsFlushT);
                __syLsFlushT = setTimeout(function () { __syLsFlushT = null; __syFlushLsNow(); }, 400);
            };
            var __sySeed = (self.__syLsCtx && self.__syLsCtx.seed) || null;
            try {
                Object.defineProperty(window, "localStorage", {
                    configurable: true,
                    writable: true,
                    value: __syMkStorage(__sySeed, function (d) { __syLsDict = d; __syFlushLsSoon(); }),
                });
            } catch (e) {}
            try {
                Object.defineProperty(window, "sessionStorage", {
                    configurable: true,
                    writable: true,
                    value: __syMkStorage(null, null),
                });
            } catch (e) {}
            // 导航销毁文档前把挂起的写入立即回灌（防抖窗口内关弹窗不丢尾数据）
            try { self.addEventListener("beforeunload", __syFlushLsNow); } catch (e) {}
        }
    } catch (e) {}
    // ★ confirm/alert 抑制：扩展 JS（实测 TM options）的 window.onerror 兜底
    //   会弹原生 confirm（"An internal error occurred..."）—— Electron 下该
    //   对话框同步阻塞 JS 线程直到用户点按钮，页面表现为假死（CDP evaluate/
    //   截图全部超时）。扩展世界静默吞掉它们并记录参数，主世界不受影响。
    try {
        window.__syBlockedDialogs = [];
        window.confirm = function (msg) { try { window.__syBlockedDialogs.push("confirm: " + msg); } catch (e) {} return false; };
        window.alert = function (msg) { try { window.__syBlockedDialogs.push("alert: " + msg); } catch (e) {} };
        window.prompt = function (msg, dflt) { try { window.__syBlockedDialogs.push("prompt: " + msg); } catch (e) {} return dflt === undefined ? null : dflt; };
    } catch (e) {}
    // ★ 未捕获异常收集器：TM onerror 弹框的场景，真实异常细节记到
    //   __syErrors 供宿主事后读（弹框文案不含栈）。
    try {
        window.__syErrors = [];
        self.addEventListener("error", function (e) {
            try {
                window.__syErrors.push({ msg: String(e.message || e).slice(0, 300), stack: String((e.error && e.error.stack) || "").slice(0, 3000), file: e.filename, line: e.lineno, col: e.colno, ts: Date.now() });
            } catch (e2) {}
        });
        self.addEventListener("unhandledrejection", function (e) {
            try {
                var r = e.reason;
                window.__syErrors.push({ msg: "unhandledrejection: " + String((r && (r.stack || r.message)) || r).slice(0, 800), ts: Date.now() });
            } catch (e2) {}
        });
    } catch (e) {}
    // currentScript 伪造：webpack/rspack runtime 的 publicPath 自动检测依赖
    // document.currentScript.src；Runtime.evaluate 环境里它是 null，runtime
    // 会直接 throw "Automatic publicPath is not supported" —— 提供伪元素
    // （src = chrome-extension://<id>/<当前文件>），publicPath 语义与真实扩展一致
    self.__sySetCurrentScript = function (url) {
        try {
            var fake = document.createElement("script");
            fake.src = url;
            Object.defineProperty(document, "currentScript", {
                configurable: true,
                get: function () { return fake; },
            });
        } catch (e) {}
    };
    function wrap() {
        var h = document.getElementById("sy-ext-popup-host");
        // 注意：__syWrap 是主世界设置的 expando，跨世界不可见；
        // 用 className（DOM attribute，跨世界共享）定位
        return h ? h.querySelector(".sy-ext-popup-wrap") : null;
    }
    var body = document.body;
    var patchMethod = function (name, redirect) {
        try {
            if (typeof body[name] !== "function") return;
            var orig = body[name].bind(body);
            Object.defineProperty(body, name, {
                configurable: true,
                value: function () {
                    var w = wrap();
                    if (!w) return orig.apply(null, arguments);
                    return redirect(w, orig, arguments);
                },
            });
        } catch (e) {}
    };
    patchMethod("appendChild", function (w, orig, args) {
        var n = args[0];
        if (n && n.nodeType === 1) { w.appendChild(n); return n; }
        return orig.apply(null, args);
    });
    patchMethod("prepend", function (w, orig, args) {
        var n = args[0];
        if (n && n.nodeType === 1) { w.prepend(n); return n; }
        return orig.apply(null, args);
    });
    patchMethod("append", function (w, orig, args) { w.append.apply(w, args); });
    patchMethod("insertBefore", function (w, orig, args) { w.insertBefore(args[0], null); return args[0]; });
    try {
        var oIAE = body.insertAdjacentHTML.bind(body);
        Object.defineProperty(body, "insertAdjacentHTML", {
            configurable: true,
            value: function (pos, html) {
                var w = wrap();
                if (!w) return oIAE(pos, html);
                w.insertAdjacentHTML(pos || "beforeend", html);
            },
        });
    } catch (e) {}
    try {
        var proto = body;
        var d = null;
        var o = proto;
        while (o && !d) { d = Object.getOwnPropertyDescriptor(o, "innerHTML"); o = Object.getPrototypeOf(o); }
        if (d && d.set) {
            Object.defineProperty(body, "innerHTML", {
                configurable: true,
                get: function () { return d.get.call(this); },
                set: function (v) {
                    var w = wrap();
                    if (!w) return d.set.call(this, v);
                    w.innerHTML = v;
                },
            });
        }
    } catch (e) {}
    // body class 镜像到面板宿主：scopeCss 把 body 选择器映射为宿主根
    // （如 body:not(.popup-ready) → #sy-ext-popup-host:not(.popup-ready)），
    // 而扩展把状态类（popup-ready 等）加在 body 上 —— 不同步则面板永远
    // visibility:hidden（实测 Clip "点不开"的根因）
    try {
        var syncBodyClass = function () {
            var h = document.getElementById("sy-ext-popup-host");
            if (!h) return;
            var cls = Array.prototype.slice.call(body.classList);
            for (var i = 0; i < cls.length; i++) {
                try { h.classList.add(cls[i]); } catch (e) {}
            }
        };
        syncBodyClass();
        new MutationObserver(syncBodyClass).observe(body, { attributes: true, attributeFilter: ["class"] });
    } catch (e) {}
    // ★ 运行时 <style> 作用域化（仅 popup 模式）：扩展 popup JS（React 等）
    //   会把样式块塞进 document.head —— 不经 body 补丁，规则全局生效污染
    //   宿主页面（实测 AdGuard popup 运行时注入 23 个 style 块，含
    //   "*,*:before,*:after{box-sizing}" 与 :root/body 规则，把宿主 body
    //   压成 320px，页面布局全毁）。在隔离世界拦截 head 的 style 插入并按
    //   popup 宿主作用域化；页面自己的脚本不受影响（补丁只在本扩展世界
    //   生效）。整页扩展页模式不启用（页面本身就是扩展页，样式须全局）。
    try {
        var POPUP_MODE = !!document.getElementById("sy-ext-popup-host");
        if (POPUP_MODE) {
            var SCOPE = "#sy-ext-popup-host";
            // 作用域算法经宿主函数 toString 注入（见 syScopeCssJs 注释：模板内
            // 写正则会遭打包器非法转义二次 cooking，toString 注入零转义）
            var syScopeCss = ${syScopeCssJs.toString()};
            var scopeOnInsert = function (n) {
                try {
                    if (!n || n.tagName !== "STYLE" || n.getAttribute("data-sy-scoped")) return n;
                    var css = n.textContent || "";
                    if (css.trim().length > 4) {
                        n.textContent = syScopeCss(css, SCOPE);
                        n.setAttribute("data-sy-scoped", "1");
                    }
                } catch (e) {}
                return n;
            };
            var patchHeadMethod = function (name) {
                try {
                    var el = document.head || document.documentElement;
                    if (typeof el[name] !== "function") return;
                    var orig = el[name].bind(el);
                    Object.defineProperty(el, name, {
                        configurable: true,
                        value: function () {
                            for (var i = 0; i < arguments.length; i++) scopeOnInsert(arguments[i]);
                            return orig.apply(el, arguments);
                        },
                    });
                } catch (e) {}
            };
            patchHeadMethod("appendChild");
            patchHeadMethod("prepend");
            patchHeadMethod("insertBefore");
            patchHeadMethod("append");
        }
    } catch (e) {}
})();
`;

/** 括号感知的顶层逗号分割（:not(a,b) 这类不切错） */
function splitTopLevel(s: string): string[] {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (const ch of s) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
        else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * CSS 作用域重写：每条规则的选择器前缀 scopeSel；html/body/:root 映射为
 * scopeSel 本身；`*` 映射为 scopeSel 内的通配；@keyframes/@font-face 原样保留。
 * 让 popup.css 只作用于面板，不污染宿主页面。
 */
function scopeCss(css: string, scopeSel: string): string {
    const mapSel = (sel: string): string => {
        const parts = splitTopLevel(sel).map((t) => {
            const replaced = t.replace(/(^|[\s>+~,])(html|body|:root)(?=[\s.#[{,:]|$)/gi, (_m, pre) => pre + scopeSel);
            if (replaced !== t) return replaced;
            const star = t.replace(/(^|[\s>+~,]|\b)\*(?=[\s.#[{,:]|$)/g, (_m, pre) => pre + scopeSel + " *");
            if (star !== t) return star;
            return scopeSel + " " + t;
        });
        return parts.join(", ");
    };
    const walk = (src: string): string => {
        const out: string[] = [];
        let i = 0;
        while (i < src.length) {
            const brace = src.indexOf("{", i);
            if (brace < 0) break;
            const sel = src.slice(i, brace).trim();
            let depth = 1;
            let j = brace + 1;
            while (j < src.length && depth > 0) {
                if (src[j] === "{") depth++;
                else if (src[j] === "}") depth--;
                j++;
            }
            const body = src.slice(brace + 1, j - 1);
            i = j;
            if (/^@keyframes/i.test(sel) || /^@font-face/i.test(sel) || /^@charset/i.test(sel)) {
                out.push(sel + "{" + body + "}");
            } else if (/^@(media|supports|layer)/i.test(sel)) {
                out.push(sel + "{" + walk(body) + "}");
            } else {
                out.push(mapSel(sel) + "{" + body + "}");
            }
        }
        return out.join("\n");
    };
    return walk(css);
}

/**
 * location 身份伪装：popup 世界寄生在宿主页面里，location 是宿主页面的
 * （location 本体 Unforgeable，无法 defineProperty 覆盖）。但扩展 popup 的
 * 引导逻辑按 location.pathname 分派（TM："/action"→popup 分支、"/options"、
 * "/ask"…），pathname 不对则整个 UI 引导被跳过（面板只有壳）。
 *
 * 手段：① 源码里定长 token 替换 `window.location` → 伪对象 __syFakeLoc；
 * ② 整段源码用 `(function (location){…})(__syFakeLoc)` 包一层，遮蔽裸
 * `location`。伪对象 pathname/href/origin 等给扩展页 URL；hash 读写穿透到
 * 真实 location（TM 靠 hashchange 切视图，需真事件）；href/reload/replace
 * 写操作 no-op（防错误兜底把宿主页面导航走）。
 */
export function spoofLocationPrelude(spoofUrl: string): string {
    let u: URL;
    try {
        u = new URL(spoofUrl);
    } catch {
        return ""; // 非法 URL：放弃伪装
    }
    const base = JSON.stringify({
        href: u.href, origin: u.origin, protocol: u.protocol, host: u.host,
        hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
    });
    return `self.__syFakeLoc = (function (real) {
    var base = ${base};
    var o = {};
    o.pathname = base.pathname; o.origin = base.origin; o.protocol = base.protocol;
    o.host = base.host; o.hostname = base.hostname; o.port = base.port; o.search = base.search;
    Object.defineProperty(o, "href", { get: function () { return base.href; }, set: function () { try { console.warn("[sy-ext] location.href 写入被忽略（面板伪装）"); } catch (e) {} } });
    Object.defineProperty(o, "hash", {
        // 整页重建场景真实 location 是 about:blank（hash 恒空）：读操作兜底回
        // 伪装 URL 自带的初始 hash（TM 靠 #nav=xxx 深链定位视图）；一旦真实
        // hash 被 hashchange 流程写过就按真实的来（set 穿透到 real）
        get: function () { try { return real.hash || base.hash; } catch (e) { return base.hash || ""; } },
        set: function (v) { try { real.hash = v; } catch (e) {} },
    });
    o.reload = function () {};
    o.replace = function () {};
    o.toString = function () { return base.href; };
    try { o.ancestorOrigins = real.ancestorOrigins; } catch (e) {}
    return o;
})(location);`;
}

/** token 替换：源码里的 window.location → 伪对象引用（整段遮蔽前的第一步） */
function spoofLocationTokenReplace(src: string): string {
    return String(src).split("window.location").join("__syFakeLoc");
}

function spoofLocationWrap(src: string, spoofUrl: string): string {
    const prelude = spoofLocationPrelude(spoofUrl);
    if (!prelude) return src; // 非法 URL：放弃伪装，保持原样
    const rewritten = spoofLocationTokenReplace(src);
    return prelude + "\n;(function (location) {\n" + rewritten + "\n})(self.__syFakeLoc);";
}

/**
 * 在目标页内展示扩展 popup。
 *
 * @param webview      目标标签的 webview
 * @param extPath      扩展解压目录（绝对路径）
 * @param electronId   Electron 侧扩展 id（拼 chrome-extension:// 资源 URL 用）
 * @param popupPath    manifest.action.default_popup 的相对路径（如 popup.html）
 * @param anchorRect   触发图标在工具栏里的位置（面板靠它的右下对齐）
 * @param evalJs       提供时：popup 的 JS 经此回调执行（推荐传 cs-runtime 的扩展
 *                     专属世界 —— 原生加载扩展在页面主世界没有可用 chrome.*）；
 *                     不提供时退回主世界内联执行（仅对不依赖 chrome 的扩展有效）
 */
export async function showExtensionPopupInPage(opts: {
    webview: IWebviewTag;
    extPath: string;
    electronId: string;
    popupPath: string;
    anchorRect?: { right: number; bottom: number };
    /** 开始一次 popup 会话（新建扩展世界）—— 在首个脚本执行前调用一次 */
    begin?: () => Promise<void>;
    evalJs?: (src: string, relPath: string) => Promise<any>;
    /** 伪装的扩展页 URL（chrome-extension://<id>/<popup>）—— 传入后 popup JS
     * 看到的 location 是该 URL（TM 等按 pathname 分派引导分支的扩展必需） */
    spoofLocationUrl?: string;
}): Promise<{ ok: boolean; error?: string }> {
    const { webview, extPath, electronId, popupPath, anchorRect } = opts;
    try {
        const { fs, path } = nodeMods();
        const htmlPath = path.join(extPath, popupPath);
        const html = readText(fs, htmlPath);
        if (!html) return { ok: false, error: `popup 文件不存在: ${popupPath}` };

        // 相对 popup.html 所在目录解析 css/js
        const baseDir = path.dirname(popupPath).replace(/\\/g, "/");
        const resolveRel = (rel: string): string => {
            if (/^(https?:|data:|chrome-extension:)/i.test(rel)) return rel;
            const norm = rel.replace(/^\.\//, "");
            return baseDir && baseDir !== "." ? `${baseDir}/${norm}` : norm;
        };

        const cssLinks = collectCssHrefs(html);
        const scriptItems = collectScriptSrcs(html);

        // css 内容内联（样式里的相对 url() 也需要重写，简化处理：只处理 chrome-extension 绝对化）。
        // light DOM 下为免 popup.css 的 body/* 全局规则污染宿主页面，做作用域重写。
        const cssBlocks: string[] = [];
        for (const rel of cssLinks) {
            const abs = path.join(extPath, resolveRel(rel));
            const css = readText(fs, abs);
            if (css) cssBlocks.push(scopeCss(rewriteUrls(css, electronId), "#sy-ext-popup-host"));
        }

        // js 源码读出后 inline 执行（executeJavaScript 的字符串里 eval）
        // 注意：scriptSrcs 已由 jsRels 经 resolveRel 解析过，这里不能再解析一次
        // （二次解析会把 "../pages/popup.js" 变成 "pages/../pages/popup.js" 的另一层
        //  前缀 → 文件读不到 → jsSources 为空 → 脚本从不执行；AdGuard 因此完全不渲染）
        const jsSources: string[] = [];
        for (const item of scriptItems) {
            if (item.kind === "src") {
                const abs = path.join(extPath, resolveRel(item.value));
                const js = readText(fs, abs);
                if (js) jsSources.push(js); // JS 不改写（见 injectExtensionPageRuntime 注释）；location 伪装见 spoofLocationWrap
            } else {
                jsSources.push(item.value);
            }
        }
        // location 伪装只走 evalJs 通道（扩展世界）；legacy 主世界内联执行保持原样
        const wrapLocation = (src: string, relPath: string): string =>
            opts.spoofLocationUrl && useEvalJs ? spoofLocationWrap(src, opts.spoofLocationUrl) : src;

        const bodyHtml = rewriteUrls(extractBody(html), electronId);

        // JS 执行通道：evalJs（扩展世界）优先；否则内联进主世界（legacy，原生加载扩展在主世界没有可用 chrome.*）
        const useEvalJs = typeof opts.evalJs === "function";
        // 组装注入脚本。所有用户内容一律 JSON.stringify 后再嵌入，避免引号/反斜杠破坏字符串。
        const payload = {
            bodyHtml,
            css: cssBlocks.join("\n"),
            js: useEvalJs ? [] : jsSources,
            anchor: anchorRect || null,
        };
        const runner = `
(function () {
    if (window.__syExtPopup) { window.__syExtPopup.close(); }
    var P = ${JSON.stringify(payload)};
    // 作用域算法经宿主函数 toString 注入（见 syScopeCssJs 注释）：模板内写正则
    // 会遭打包器非法转义二次 cooking，toString 注入零转义
    var syScopeCssJs = ${syScopeCssJs.toString()};
    var host = document.createElement("div");
    host.id = "sy-ext-popup-host";
    host.style.cssText = "position:fixed;z-index:2147483647;width:360px;max-height:520px;overflow:auto;"
        + "background:#fff;color:#202124;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.28);"
        + "font-size:13px;";
    // light DOM（不用 shadow）：扩展 popup JS 用 document.getElementById / body.appendChild
    // 找自己的控件，shadow 会隔离它们的查找与挂载
    var style = document.createElement("style");
    style.textContent = P.css + "\\n#sy-ext-popup-close{position:absolute;top:4px;right:8px;cursor:pointer;"
        + "color:#5f6368;font-size:14px;line-height:1;}"
        + "\\n.sy-ext-popup-wrap{position:relative;}";
    host.appendChild(style);
    var wrap = document.createElement("div");
    wrap.className = "sy-ext-popup-wrap";
    host.__syWrap = wrap;
    var closeBtn = document.createElement("span");
    closeBtn.id = "sy-ext-popup-close";
    closeBtn.textContent = "\\u00d7";
    closeBtn.addEventListener("click", function () { close(); });
    wrap.appendChild(closeBtn);
    var content = document.createElement("div");
    content.innerHTML = P.bodyHtml;
    wrap.appendChild(content);
    host.appendChild(wrap);
    // body 未就绪时挂 documentElement 也能显示
    (document.body || document.documentElement).appendChild(host);
    // ★ 运行时样式守卫（主世界兜底）：扩展 popup JS（React 等）运行时把样式块
    //   塞进 document.head —— 不经 body 补丁，规则全局生效污染宿主页面（实测
    //   AdGuard popup 注入 19+ 个 style 块把宿主 body 压成 320px，页面布局全
    //   毁）。popup 存续期间监视 head，凡新增 <style>（不管来自哪个世界）一律
    //   按 popup 宿主作用域化；关闭时停止监视。漏网代价远小于布局全毁。
    var styleMo = null;
    try {
        styleMo = new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var added = muts[i].addedNodes || [];
                for (var k = 0; k < added.length; k++) {
                    var n = added[k];
                    if (!n || n.nodeType !== 1) continue;
                    var styles = n.tagName === "STYLE" ? [n] : [];
                    if (n.querySelectorAll) Array.prototype.push.apply(styles, n.querySelectorAll("style"));
                    for (var s = 0; s < styles.length; s++) {
                        var st = styles[s];
                        if (st.getAttribute("data-sy-scoped")) continue;
                        if (st.closest && st.closest("#sy-ext-popup-host")) continue;
                        try {
                            var css2 = st.textContent || "";
                            if (css2.trim().length > 4) {
                                st.textContent = syScopeCssJs(css2, "#sy-ext-popup-host");
                                st.setAttribute("data-sy-scoped", "1");
                            }
                        } catch (e3) {}
                    }
                }
            }
        });
        styleMo.observe(document.head || document.documentElement, {childList: true, subtree: true});
    } catch (e2) {}
    function position() {
        var a = P.anchor;
        var r = host.getBoundingClientRect();
        var right = a ? a.right : 24;
        var bottom = a ? (a.bottom + 6) : 60;
        var left = Math.max(8, Math.min(right - r.width, (window.innerWidth || 800) - r.width - 8));
        var top = Math.max(8, Math.min(bottom, (window.innerHeight || 600) - r.height - 8));
        host.style.left = left + "px";
        host.style.top = top + "px";
    }
    function close() {
        try { host.remove(); } catch (e) {}
        try { styleMo && styleMo.disconnect(); } catch (e) {}
        document.removeEventListener("mousedown", onOutside, true);
        document.removeEventListener("keydown", onKey, true);
        delete window.__syExtPopup;
    }
    function onOutside(ev) {
        if (!host.contains(ev.target) && ev.target !== host) close();
    }
    function onKey(ev) { if (ev.key === "Escape") close(); }
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    position();
    window.__syExtPopup = { close: close };
    // 扩展自己的 JS 由宿主按 evalJs 通道执行（扩展专属世界，chrome.* 可用）
    return true;
})()`;
        const r = await webview.executeJavaScript(runner, false);
        const dbg2 = (msg: any) => {
            try {
                (window as any).__syPopupDbg2 = { ts: Date.now(), popupPath, ...(typeof msg === "object" ? msg : { msg }) };
            } catch (e) {}
        };
        dbg2({ jsCount: jsSources.length, useEvalJs, runnerOk: r === true, htmlLen: html.length });
        if (r !== true) {
            dbg2({ ok: false, error: "popup 注入失败" });
            return { ok: false, error: "popup 注入失败" };
        }
        if (useEvalJs) {
            // 按(html 顺序)逐文件执行 —— 每文件等价于真实浏览器的独立 script 标签
            // （webpack chunk push → runtime 初始化消化的模式依赖这个语义）。
            // 重声明问题已由「每次打开新建 popup 世界」根治，无需打包。
            // ★ begin 先新建世界，本次打开的所有文件共享它（世界复用会声明冲突，
            //   逐文件新建会把 webpack 的 chunk/runtime 拆散到多个世界）。
            if (opts.begin) await opts.begin();
            // 每个文件执行前伪造 document.currentScript（webpack/rspack publicPath 检测依赖它）
            await opts.evalJs(POPUP_JS_PRELUDE, "__prelude__");
            for (let i = 0; i < jsSources.length; i++) {
                const relLabel = String((scriptItems[i] && (scriptItems[i].kind === "src" ? scriptItems[i].value : "inline#" + i)) || "script" + i);
                try {
                    await opts.evalJs(wrapLocation(jsSources[i], relLabel), relLabel);
                } catch (e: any) {
                    const err = "popup 脚本执行失败[" + i + "](" + relLabel + "): " + String(e?.message || e).slice(0, 200);
                    dbg2({ ok: false, error: err });
                    return { ok: false, error: err };
                }
            }
            // DOMContentLoaded 兜底：重放注入时文档已就绪，DOMContentLoaded 不会再触发，
            // 扩展在它的回调里做的初始化/监听注册会永久错过 —— 每世界补发一次。
            try {
                await opts.evalJs(
                    `(function () {
                        if (document.readyState === "loading") return "loading";
                        if (self.__syDomReadyDispatched) return "already";
                        self.__syDomReadyDispatched = true;
                        try { document.dispatchEvent(new Event("DOMContentLoaded")); } catch (e) {}
                        // window load 同理补发（部分扩展的引导挂在 window load 上，
                        // 重建页面的真实 load 早于脚本注册 —— 实测 SiYuan Clip
                        // options 面板空壳的根因之一）
                        try { window.dispatchEvent(new Event("load")); } catch (e) {}
                        return "dispatched";
                    })()`,
                    "__domready__"
                );
            } catch (e) {}
        }
        dbg2({ ok: true });
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
}

/** 关闭目标页里已打开的 popup（切换标签/导航时调用，避免面板悬挂在错误页面） */
export async function closeExtensionPopupInPage(webview: IWebviewTag): Promise<void> {
    try {
        await webview.executeJavaScript(
            `try { window.__syExtPopup && window.__syExtPopup.close(); } catch (e) {}`,
            false,
        );
    } catch {}
}

/**
 * 整页打开扩展页面（chrome-extension://...）时的垫片注入。
 *
 * 与 showExtensionPopupInPage（页内弹出）不同：页面 DOM 与 <link> 样式已由
 * webview 原生加载完毕，无需重建 DOM / 重写 CSS。缺的只是 chrome.* 运行时：
 * 主世界里 Electron 原生绑定的 API 受限（storage.sync 抛错、sendMessage 报
 * "Receiving end does not exist"），页面脚本跑一遍就死在 loading 动画上。
 * 因此只需：(1) begin() 新建扩展专属世界装垫片；(2) 把页面引用的脚本在该
 * 世界按 HTML 顺序重放（逐文件伪造 currentScript，webpack/rspack 的
 * publicPath 检测依赖它）。
 * PRELUDE 的 body 挂载重定向在本场景安全复用 —— 无 #sy-ext-popup-host 时
 * 全部透传真实 body。
 *
 * @param pagePath URL path（不含 query/hash），如 "pages/popup.html"
 */
export async function injectExtensionPageRuntime(opts: {
    webview: IWebviewTag;
    extPath: string;
    electronId: string;
    pagePath: string;
    /** 开始一次扩展世界会话（新建世界装垫片）—— 在首个脚本执行前调用一次 */
    begin?: () => Promise<void>;
    /** 逐文件执行通道（扩展专属世界） */
    evalJs?: (src: string, relPath: string) => Promise<any>;
    /** 整页 DOM 重建：Electron 44 实测 webview 加载 chrome-extension:// 被拒
     *  （退 about:blank），页面 DOM/CSS 不会原生存在 —— 从磁盘读 html 把
     *  body/标题/样式重建进当前文档后再重放脚本。默认 false（保持"原生
     *  已加载、只补运行时"的旧假设）。 */
    rebuildDom?: boolean;
    /** 伪装的扩展页 URL（chrome-extension://<id>/<page>，含 hash）—— 传入后
     * 重放的页面脚本看到的 location 是该 URL。TM 等扩展的引导按
     * location.pathname 分派分支（/options、/action…），改道重建场景页面真实
     * location 是 about:blank，分支分派落空 → 脚本静默空转（无错无 UI）。 */
    spoofLocationUrl?: string;
    /** localStorage 垫片种子（宿主页 localStorage 的 syExtLs::<extId> 快照）。
     * 模拟扩展文档（about:blank 不透明源）原生 localStorage 被拒，垫片起于
     * 种子、写入防抖回灌宿主（见 POPUP_JS_PRELUDE）。真实源文档不装垫片，
     * 传了也无副作用。 */
    lsSeed?: Record<string, string> | null;
}): Promise<{ ok: boolean; error?: string; scripts?: number }> {
    const { webview, extPath, electronId, pagePath } = opts;
    try {
        const { fs, path } = nodeMods();
        const pageRel = decodeURIComponent(pagePath || "index.html");

        const html = readText(fs, path.join(extPath, pageRel));
        if (!html) return { ok: false, error: "页面文件不存在: " + pageRel };

        // 相对页面所在目录解析脚本（../ 回退由 path.join 正规化吸收）
        const baseDir = path.dirname(pageRel).replace(/\\/g, "/");
        const resolveRel = (rel: string): string => {
            if (/^(https?:|data:|chrome-extension:)/i.test(rel)) return rel;
            const norm = rel.replace(/^\.\//, "");
            return baseDir && baseDir !== "." ? `${baseDir}/${norm}` : norm;
        };
        const scriptItems = collectScriptSrcs(html);

        // 整页 DOM 重建（webview 加载 chrome-extension:// 被拒退 about:blank 时）：
        // body（含开标签属性）+ 标题 + 全局样式从磁盘重建进当前文档。
        // CSS 全局生效（本页就是扩展页本身，无需 popup 的 host 作用域）；
        // CSS 里的相对 url() 同步绝对化。
        if (opts.rebuildDom) {
            // ★ 主世界对话框抑制先行：扩展页重放期任何时序错乱（bridge 报错回退
            //   主世界 / PRELUDE 未及安装，实测热重载恢复窗口 TM 引导失败的
            //   "An internal error occurred" 裸 confirm 漏成原生对话框）都不再
            //   阻塞渲染线程——Electron 原生对话框是同步阻塞的（P0 实测 4 叠框）。
            //   扩展世界那份在 POPUP_JS_PRELUDE（opts.evalJs 注入），两世界各一份。
            await webview.executeJavaScript(SUPPRESS_DIALOGS_JS, false).catch(() => {});
            const cssBlocks: string[] = [];
            for (const rel of collectCssHrefs(html)) {
                const abs = path.join(extPath, resolveRel(rel));
                const css = readText(fs, abs);
                if (css) cssBlocks.push(rewriteCssUrls(css, electronId));
            }
            // <base> 指向扩展根：真实文档是 about:blank，运行时相对 URL（如 TM 的
            // new Worker("lint.js")）会按 about:blank 基准解析成非法 URL —— base
            // 统一修正整类问题（Worker/importScripts/img/相对链接）
            const baseHref = `chrome-extension://${electronId}/`;
            const payload = {
                title: extractTitle(html),
                bodyAttrs: extractBodyAttrs(html),
                bodyHtml: rewriteUrls(extractBody(html), electronId),
                css: cssBlocks.join("\n"),
                baseHref,
            };
            const rebuild = `
(function () {
    try {
        var P = ${JSON.stringify(payload)};
        if (P.title) document.title = P.title;
        var oldBase = document.querySelector("base[id=sy-ext-page-base]");
        if (oldBase) oldBase.remove();
        var base = document.createElement("base");
        base.id = "sy-ext-page-base";
        base.href = P.baseHref;
        (document.head || document.documentElement).insertBefore(base, (document.head || document.documentElement).firstChild);
        var old = document.getElementById("sy-ext-page-style");
        if (old) old.remove();
        var style = document.createElement("style");
        style.id = "sy-ext-page-style";
        style.textContent = P.css;
        (document.head || document.documentElement).appendChild(style);
        var b = document.createElement("body");
        document.documentElement.replaceChild(b, document.body);
        var attrs = P.bodyAttrs ? P.bodyAttrs.split(/\\s+(?=[a-zA-Z-]+=)/) : [];
        for (var i = 0; i < attrs.length; i++) {
            var kv = attrs[i].match(/^([a-zA-Z-]+)\\s*=\\s*(["'])([\\s\\S]*)\\2$/);
            if (kv) {
                if (kv[1].toLowerCase() === "class") b.className = kv[3];
                else b.setAttribute(kv[1], kv[3]);
            }
        }
        b.innerHTML = P.bodyHtml;
        return true;
    } catch (e) { return "ERR:" + (e && e.message || e); }
})()`;
            const rr = await webview.executeJavaScript(rebuild, false);
            if (rr !== true) {
                return { ok: false, error: "整页 DOM 重建失败: " + String(rr).slice(0, 200) };
            }
        }

        const jsSources: string[] = [];
        const jsRels: string[] = [];
        for (const item of scriptItems) {
            if (item.kind === "src") {
                const rel = resolveRel(item.value);
                if (/^(https?:|data:|chrome-extension:)/i.test(rel)) continue;
                const js = readText(fs, path.join(extPath, rel));
                if (js) {
                    // JS 源码绝不能过 rewriteUrls：它是 HTML 属性改写器，作用到
                    // JS 上会把字符串闭引号误认成 src=" 的开引号，吞掉两段代码
                    // 生成相邻字符串字面量（实测 TM extension.js line 611 语法错误）
                    jsSources.push(js);
                    jsRels.push(rel);
                }
            } else {
                jsSources.push(item.value);
                jsRels.push(pageRel + "#inline" + jsRels.length);
            }
        }

        if (typeof opts.evalJs !== "function") {
            return { ok: false, error: "未提供 evalJs 通道（主世界无可用 chrome.*）" };
        }

        // 主世界已跑过一遍页面脚本（Electron 原生受限 chrome.*，半死状态），
        // 先清掉它渲染的挂载点内容，避免隔离世界重放后出现双份 UI。
        // rebuildDom 场景不适用：DOM 刚从磁盘重建，root 里就是初始骨架，
        // 再清一遍会把静态内容洗掉（SPA root 空则无碍，有静态骨架则致命）。
        if (!opts.rebuildDom) {
            try {
                await webview.executeJavaScript(
                    "try { ['root','root-portal'].forEach(function (id) { var n = document.getElementById(id); if (n) n.innerHTML = ''; }); } catch (e) {} true",
                    false,
                );
            } catch {}
        }

        if (opts.begin) await opts.begin();
        // localStorage 垫片种子先于 prelude 落地（prelude 安装垫片时读取）
        if (opts.lsSeed && Object.keys(opts.lsSeed).length > 0) {
            try {
                await opts.evalJs("self.__syLsCtx = " + JSON.stringify({ extId: electronId, seed: opts.lsSeed }) + ";", "__lsseed__");
            } catch {}
        }
        await opts.evalJs(POPUP_JS_PRELUDE, "__prelude__");
        // 合并单次求值：对齐 Chrome 的多 <script> 语义（同一全局词法作用域，
        // 传统多文件扩展的顶层函数跨文件可见）。逐文件独立求值会把 lib 的
        // 顶层函数锁进各自作用域，后续文件全局不可见（实测 SiYuan Clip 面板
        // 空壳：bootstrapPopup 报 siyuanLoadStorageSettings is not defined）。
        // currentScript 逐文件伪造保留（webpack publicPath 检测依赖）。
        // 全部文件放进**同一个** spoof IIFE：传统多文件扩展的顶层函数声明
        // 必须在同一函数作用域内才能跨文件可见（逐文件 IIFE 会把 lib 函数锁进
        // 各自作用域 —— 实测 SiYuan Clip 面板空壳的根因）；location 伪装对整段
        // 统一生效（prelude 一次 + 单层形参遮蔽）。
        const parts = jsSources.map((s, i) => {
            const src = opts.spoofLocationUrl
                ? spoofLocationTokenReplace(s)
                : s;
            const fakeUrl = "chrome-extension://" + electronId + "/" + String(jsRels[i]).replace(/^\.\//, "");
            return "self.__sySetCurrentScript && self.__sySetCurrentScript(" + JSON.stringify(fakeUrl) + ");\n" + src;
        });
        const combinedSrc = (opts.spoofLocationUrl
            ? spoofLocationPrelude(opts.spoofLocationUrl)
                + "\n;(function (location) {\n" + parts.join("\n;\n") + "\n})(self.__syFakeLoc);"
            : parts.join("\n;\n"));
        await opts.evalJs(combinedSrc, "__scripts__");
        // DOMContentLoaded 兜底（与 showExtensionPopupInPage 同理由）
        try {
            await opts.evalJs(
                `(function () {
                    if (document.readyState === "loading") return "loading";
                    if (self.__syDomReadyDispatched) return "already";
                    self.__syDomReadyDispatched = true;
                    try { document.dispatchEvent(new Event("DOMContentLoaded")); } catch (e) {}
                    return "dispatched";
                })()`,
                "__domready__"
            );
        } catch (e) {}
        return { ok: true, scripts: jsSources.length };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
}

/** 主世界对话框抑制（rebuildDom 先行注入主世界，与 POPUP_JS_PRELUDE 的扩展世界
 *  版本成对）：时序错乱导致脚本回退主世界 / PRELUDE 未及安装时，TM 引导失败的
 *  裸 confirm 不再漏成 Electron 原生同步阻塞对话框（P0 实测 4 叠框假死）。 */
export const SUPPRESS_DIALOGS_JS = `
(function () {
    try {
        window.__syBlockedDialogs = window.__syBlockedDialogs || [];
        var mk = function (kind) {
            return function (msg) { try { window.__syBlockedDialogs.push(kind + ": " + msg); } catch (e) {} return kind === "confirm" ? false : undefined; };
        };
        window.confirm = mk("confirm");
        window.alert = mk("alert");
        window.prompt = mk("prompt");
    } catch (e) {}
})()`;