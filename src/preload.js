/**
 * webview preload 脚本
 *
 * 在每个 webview 页面加载前注入，用于：
 * 1. 拦截 window.open() 调用 → 通过 ipcRenderer.sendToHost 通知父进程在新页签打开
 * 2. 拦截所有 <a> 链接点击 → 同上（在思源新标签页打开，而非在当前 webview 内导航）
 * 3. 拦截 form[target=_blank] 提交
 *
 * 注意：该脚本由 Electron webview 在隔离上下文中执行，可直接 require('electron')。
 * 不经过 webpack 打包，作为静态资源由 CopyWebpackPlugin 复制到 .src/preload.js。
 */
(function () {
    try {
        const { ipcRenderer } = require("electron");

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
        // 防止页面通过 defineProperty 重新覆盖（非强制，保持兼容性）
        try {
            Object.defineProperty(window, "open", {
                configurable: false,
                writable: false,
                value: window.open,
            });
        } catch {}

        // === 2. 拦截所有链接点击 → 在思源新标签页打开 ===
        // 包括：普通链接、target=_blank/_top/_parent、Ctrl/Cmd+点击、中键点击
        document.addEventListener(
            "click",
            function (e) {
                // 仅处理左键(0)和中键(1)
                if (e.button !== 0 && e.button !== 1) return;
                const target = e.target;
                if (!target || typeof target.closest !== "function") return;
                const link = target.closest("a");
                if (!link) return;
                const href = link.href;
                if (!href) return;
                // 仅拦截 http(s) 链接，mailto:/tel:/# 等放行
                if (!isHttpUrl(href)) return;
                // 阻止 webview 内导航，改为在思源新标签页打开
                e.preventDefault();
                e.stopPropagation();
                openInNewTab(href);
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

        // 标记已注入，便于父进程通过 executeJavaScript 验证
        window.__browserPluginPreloadInjected = true;
    } catch (err) {
        // preload 失败不应阻塞页面加载
        // eslint-disable-next-line no-console
        console.warn("[browser-plugin preload] init failed:", err);
    }
})();
