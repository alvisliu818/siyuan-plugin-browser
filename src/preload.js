/**
 * webview preload 脚本
 *
 * 在每个 webview 页面加载前注入，用于：
 * 1. 拦截 window.open() 调用 → 通过 ipcRenderer.sendToHost 通知父进程在新页签打开
 * 2. 拦截所有 <a> 链接点击 → 同上（在思源新标签页打开，而非在当前 webview 内导航）
 * 3. 拦截 form[target=_blank] 提交
 * 4. 扩展页面（chrome-extension://）下补齐 Electron 缺失的 chrome.storage.sync
 *
 * 注意：该脚本由 Electron webview 在隔离上下文中执行，可直接 require('electron')。
 * 不经过 webpack 打包，作为静态资源由 CopyWebpackPlugin 复制到 .src/preload.js。
 */
(function () {
    try {
        const { ipcRenderer, webFrame } = require("electron");

        // === -1. 扩展页面（chrome-extension://）：抑制原生 confirm/alert/prompt + 收集未捕获异常 ===
        // Electron 下 window.confirm 是**原生同步对话框**（标题=主窗口标题），扩展
        // JS 的全局 onerror 兜底一弹，整个页面 JS 线程假死（实测 TM Dashboard 的
        // "An internal error occurred" 弹框，CDP evaluate/Debugger 全部超时）。
        // preload 与页面共享 window（webpreferences contextIsolation=no）且先于
        // 页面脚本执行 —— 主世界从这里就挂上抑制；隔离世界的重放脚本由
        // ext-popup.ts 的 POPUP_JS_PRELUDE 另行挂钩（本段不覆盖那个世界）。
        // 与 PRELUDE 语义一致：吞掉对话框、返回"取消"，记录到 __syBlockedDialogs
        // 供诊断；异常进 __syErrors（window.onerror 只留一行日志，栈拿不到）。
        if (/^chrome-extension:\/\//i.test(location.href)) {
            window.__syBlockedDialogs = [];
            window.__syErrors = [];
            window.confirm = function (msg) {
                try { window.__syBlockedDialogs.push("confirm: " + String(msg).slice(0, 500)); } catch (e) {}
                return false;
            };
            window.alert = function (msg) {
                try { window.__syBlockedDialogs.push("alert: " + String(msg).slice(0, 500)); } catch (e) {}
            };
            window.prompt = function (msg, dflt) {
                try { window.__syBlockedDialogs.push("prompt: " + String(msg).slice(0, 500)); } catch (e) {}
                return dflt === undefined ? null : dflt;
            };
            self.addEventListener("error", function (e) {
                try {
                    window.__syErrors.push({
                        msg: String((e && e.message) || e).slice(0, 300),
                        stack: String((e && e.error && e.error.stack) || "").slice(0, 3000),
                        file: e && e.filename,
                        line: e && e.lineno,
                        col: e && e.colno,
                        ts: Date.now(),
                    });
                } catch (e2) {}
            });
            self.addEventListener("unhandledrejection", function (e) {
                try {
                    var r = e && e.reason;
                    window.__syErrors.push({
                        msg: "unhandledrejection: " + String((r && (r.stack || r.message)) || r).slice(0, 800),
                        ts: Date.now(),
                    });
                } catch (e2) {}
            });
        }

        // === 0. Ctrl+滚轮 / Ctrl+0 页面缩放（Chromium page zoom，webFrame 渲染进程标准 API）===
        // 缩放后固定宽度站点会横向溢出并出现滚动条（与真浏览器行为一致）。
        try {
            const ZOOM_MIN = 0.25;
            const ZOOM_MAX = 3;
            window.addEventListener(
                "wheel",
                (e) => {
                    if (!e.ctrlKey) return;
                    e.preventDefault();
                    const cur = webFrame.getZoomFactor();
                    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
                    if (Math.abs(next - cur) > 1e-6) webFrame.setZoomFactor(next);
                },
                { passive: false }
            );
            window.addEventListener(
                "keydown",
                (e) => {
                    if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
                    // Ctrl+0 重置；Ctrl+= / Ctrl+- 步进缩放（对齐 Chrome 快捷键）
                    if (e.key === "0" || e.code === "Digit0") {
                        e.preventDefault();
                        webFrame.setZoomLevel(0); // 0 = 100%
                    } else if (e.key === "=" || e.key === "+") {
                        e.preventDefault();
                        const next = Math.min(ZOOM_MAX, webFrame.getZoomFactor() * 1.1);
                        if (Math.abs(next - webFrame.getZoomFactor()) > 1e-6) webFrame.setZoomFactor(next);
                    } else if (e.key === "-") {
                        e.preventDefault();
                        const next2 = Math.max(ZOOM_MIN, webFrame.getZoomFactor() / 1.1);
                        if (Math.abs(next2 - webFrame.getZoomFactor()) > 1e-6) webFrame.setZoomFactor(next2);
                    }
                },
                { passive: false }
            );
            // F12 转发到宿主：打开扩展 popup/options 的 DevTools
            window.addEventListener(
                "keydown",
                (e) => {
                    if (e.key === "F12") {
                        e.preventDefault();
                        ipcRenderer.sendToHost("sy-open-devtools");
                    }
                },
            );
            // 扩展页 localStorage 回灌通道：overlay 的模拟扩展文档跑在 about:blank
            // （不透明源）上，localStorage 被原生拒绝，guest 里的垫片（POPUP_JS_PRELUDE）
            // 写入后经此把快照回灌宿主页持久化。仅 about:blank 主帧暴露 —— 真实站点
            // （http/https）绝不暴露，防网页伪造扩展存储。
            try {
                if (location.protocol === "about:" && window.top === window) {
                    window.__syExtLsSend = function (extId, data) {
                        try { ipcRenderer.sendToHost("sy-ext-ls-write", { extId: String(extId || ""), data: data }); } catch (e) {}
                    };
                }
            } catch (e) {}
        } catch (e) {
            console.warn("[browser-preload] zoom init failed:", e);
        }

        const openInNewTab = function (rawUrl) {
            if (!rawUrl) return;
            // 解析为绝对 URL（相对路径基于当前 location.href）
            let absUrl;
            try {
                absUrl = new URL(rawUrl, location.href).href;
            } catch {
                absUrl = String(rawUrl);
            }
            // 跳过 javascript: / mailto: / tel: 等非 http(s) 协议
            if (!/^https?:\/\//i.test(absUrl)) return;
            ipcRenderer.sendToHost("browser-open-new-tab", absUrl);
        };

        // 判断 URL 是否为 http(s) 协议
        const isHttpUrl = function (rawUrl) {
            try {
                var abs = new URL(rawUrl, location.href).href;
                return /^https?:\/\//i.test(abs);
            } catch {
                return false;
            }
        };

        // === 1. 拦截 window.open ===
        const originalOpen = window.open;
        // 创建一个"假窗口"对象，模拟 window.open 返回的窗口引用。
        // 网页常做 `var w = window.open(); w.location.href = url;`，
        // 若返回 null 会导致 `Cannot read properties of null (reading 'location')` 报错。
        // 这里返回 stub，网页对 location 的赋值会被转发到 openInNewTab。
        const createFakeWindow = function (openedUrl) {
            const fake = {
                closed: false,
                name: "",
                opener: window,
                length: 0,
                focus: function () { return fake; },
                blur: function () { return fake; },
                close: function () { fake.closed = true; },
                postMessage: function () {},
                moveTo: function () {},
                resizeTo: function () {},
                setTimeout: function (fn, t) { return setTimeout(fn, t); },
                setInterval: function (fn, t) { return setInterval(fn, t); },
                clearTimeout: function (id) { clearTimeout(id); },
                clearInterval: function (id) { clearInterval(id); },
                addEventListener: function () {},
                removeEventListener: function () {},
                document: {
                    write: function () {},
                    writeln: function () {},
                    open: function () {},
                    close: function () {},
                    createElement: function () { return { style: {}, setAttribute: function () {}, appendChild: function () {} }; },
                    getElementsByTagName: function () { return []; },
                    body: { appendChild: function () {} },
                    head: { appendChild: function () {} },
                    readyState: "complete",
                    referrer: location.href,
                    domain: location.hostname,
                    location: location.href,
                },
                navigator: { userAgent: navigator.userAgent },
                // location 通过 defineProperty 设置（见下），支持赋值重定向
            };
            // location：支持 w.location.href = url 和 w.location = url
            const fakeLocation = {
                href: openedUrl || "",
                assign: function (u) { if (u) openInNewTab(u); },
                replace: function (u) { if (u) openInNewTab(u); },
                reload: function () {},
                toString: function () { return this.href; },
            };
            // 让 fakeLocation.href = url 触发新标签页
            try {
                Object.defineProperty(fakeLocation, "href", {
                    configurable: true,
                    enumerable: true,
                    get: function () { return openedUrl || ""; },
                    set: function (v) {
                        openedUrl = String(v);
                        openInNewTab(v);
                    },
                });
            } catch {
                fakeLocation.href = openedUrl || "";
            }
            // 让 fake.location = url 触发新标签页（整体赋值）
            try {
                Object.defineProperty(fake, "location", {
                    configurable: true,
                    enumerable: true,
                    get: function () { return fakeLocation; },
                    set: function (v) {
                        if (typeof v === "string") {
                            openInNewTab(v);
                            openedUrl = v;
                        }
                    },
                });
            } catch {
                fake.location = fakeLocation;
            }
            return fake;
        };
        window.open = function (url, target, features) {
            let absUrl = "";
            if (url) {
                try { absUrl = new URL(url, location.href).href; } catch { absUrl = String(url); }
                openInNewTab(url);
            }
            // 返回 stub 窗口而非 null，避免网页脚本访问 .location 等属性时崩溃
            return createFakeWindow(absUrl);
        };
        // 注意：这里**绝不能**把 window.open 锁成只读
        // （Object.defineProperty(window, "open", {configurable:false, writable:false})）。
        // 实测 SiYuan 伺服页面（/stage/build/desktop/）在启动链里会自己给 window.open 赋值，
        // 锁定后该赋值抛 "Cannot assign to read only property 'open' of object '#<Window>'"，
        // 异常落在 promise 里直接中断前端初始化 —— 表现为页面卡在思源 loading 图标、
        // 控制台只有这一条异常、网络全部 200。
        // 保持属性可写：页面想改就让它改，did-stop-loading 的兜底注入会再夺回拦截。

        // === 2. 链接点击拦截：行为与浏览器一致 ===
        // - 普通左键：放行，让 webview 在当前页导航（替换当前页）
        //   * target=_top / _parent 在无框架的 webview 中等同于 _self（当前页导航）
        // - Ctrl/Cmd+左键、Shift+左键、中键、target=_blank：拦截并开新标签页
        document.addEventListener(
            "click",
            function (e) {
                if (e.button !== 0 && e.button !== 1) return;
                const target = e.target;
                if (!target || typeof target.closest !== "function") return;
                const link = target.closest("a");
                if (!link) return;
                const href = link.href;
                if (!href) return;
                if (!isHttpUrl(href)) return;
                // 判断是否需要开新标签页（浏览器行为）
                // 注意：_top/_parent 在无框架 webview 中等同于 _self，不开新标签页
                const openNewTab =
                    e.button === 1 ||
                    e.ctrlKey ||
                    e.metaKey ||
                    e.shiftKey ||
                    link.target === "_blank";
                if (!openNewTab) {
                    // 普通左键：放行，webview 在当前页导航
                    return;
                }
                // 需要开新标签页：拦截默认导航
                e.preventDefault();
                e.stopPropagation();
                openInNewTab(href);
            },
            true
        );

        // 中键 auxclick（部分浏览器 click 不触发中键）
        document.addEventListener(
            "auxclick",
            function (e) {
                if (e.button !== 1) return;
                const target = e.target;
                if (!target || typeof target.closest !== "function") return;
                const link = target.closest("a");
                if (!link || !link.href || !isHttpUrl(link.href)) return;
                e.preventDefault();
                e.stopPropagation();
                openInNewTab(link.href);
            },
            true
        );

        // === 3. 拦截 form 提交到 _blank ===
        document.addEventListener(
            "submit",
            function (e) {
                const form = e.target;
                if (!form || form.tagName !== "FORM") return;
                if (form.target === "_blank") {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                        const formData = new FormData(form);
                        const params = new URLSearchParams();
                        formData.forEach(function (v, k) {
                            params.append(k, String(v));
                        });
                        const url = new URL(form.action || location.href);
                        url.search = params.toString();
                        openInNewTab(url.href);
                    } catch {}
                }
            },
            true
        );

        // === 4. 页面 → 宿主事件桥（白名单通道） ===
        // 注入脚本（executeJavaScript，页面主世界）通过 CustomEvent("sy-browser-host")
        // 把白名单内的动作转给宿主，页面本身拿不到 ipcRenderer。
        // 白名单：browser-open-new-tab（新页签）/ browser-edge-install（商店安装）
        window.addEventListener("sy-browser-host", function (ev) {
            try {
                const d = ev && ev.detail;
                if (!d || typeof d.type !== "string") return;
                if (d.type === "browser-open-new-tab" && d.payload) {
                    openInNewTab(typeof d.payload === "string" ? d.payload : d.payload.url);
                } else if (d.type === "browser-edge-install" && d.payload && d.payload.id) {
                    ipcRenderer.sendToHost("browser-edge-install", String(d.payload.id));
                }
            } catch (e) {}
        });

        // === 4. 扩展页面：把 chrome.storage.sync 代理到 local ===
        //
        // Electron 只实现了 chrome.storage.local。sync **属性存在**（读它是 object），
        // 但一调用就抛
        //   Error: "sync" is not available in this instance of Chrome
        // （sync 依赖 Google 账号同步服务，Electron 没有）。
        // 实测 SiYuan Clip 把设置几乎全存在 sync 里 —— 一读就抛错，
        // 整个设置页渲染中断变成空白页。
        //
        // 所以这里**无条件**把 sync 代理到 local：读写语义一致，只是不同步到云端。
        // 不能用 `if (!chrome.storage.sync)` 判断要不要代理 —— 属性是存在的，
        // 那样判断永远不成立（实测踩过）。
        try {
            if (/^chrome-extension:\/\//i.test(location.href) && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
                Object.defineProperty(chrome.storage, "sync", {
                    configurable: true,
                    get: function () { return chrome.storage.local; },
                });
            }
        } catch (e) {}

        // === 5. Edge 加载项商店：补齐 navigator.userAgentData 的 Edge 品牌 ===
        //
        // 商店只在**页面加载时判定一次**浏览器兼容性（实测：加载后无论怎么改 UA /
        // userAgentData，「获取」按钮都不会重新变绿），所以必须在页面脚本执行前
        // 就准备好 —— preload 正好是这个时机（webpreferences 里 contextIsolation=no，
        // preload 与页面共享 window，这里改 navigator 页面看得到）。
        //
        // webContents.setUserAgent() 只能改 UA 字符串，改不动 userAgentData：
        // 实测 UA 已是 "…Edg/141.0.0.0"，但 brands 仍是 [Not?A_Brand, Chromium/152]，
        // 商店据此判定"与你的浏览器不兼容"并禁用「获取」。
        try {
            if (/^https?:\/\/microsoftedge\.microsoft\.com\//i.test(location.href)) {
                const edgeBrands = [
                    {brand: "Not?A_Brand", version: "24"},
                    {brand: "Chromium", version: "141"},
                    {brand: "Microsoft Edge", version: "141"},
                ];
                const fullVersionList = [
                    {brand: "Chromium", version: "141.0.0.0"},
                    {brand: "Microsoft Edge", version: "141.0.0.0"},
                ];
                const uaData = {
                    brands: edgeBrands,
                    mobile: false,
                    platform: "Windows",
                    architecture: "x86",
                    bitness: "64",
                    getHighEntropyValues: function () {
                        return Promise.resolve({
                            architecture: "x86",
                            bitness: "64",
                            model: "",
                            platformVersion: "15.0.0",
                            uaFullVersion: "141.0.0.0",
                            fullVersionList: fullVersionList,
                        });
                    },
                    toJSON: function () {
                        return {brands: edgeBrands, mobile: false, platform: "Windows"};
                    },
                };
                Object.defineProperty(navigator, "userAgentData", {
                    configurable: true,
                    get: function () { return uaData; },
                });
            }
        } catch (e) {}

        // 标记已注入，便于父进程通过 executeJavaScript 验证
        window.__browserPluginPreloadInjected = true;
    } catch (err) {
        // preload 失败不应阻塞页面加载
        // eslint-disable-next-line no-console
        console.warn("[browser-plugin preload] init failed:", err);
    }
})();
