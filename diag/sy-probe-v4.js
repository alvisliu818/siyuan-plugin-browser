/* sy-diag v4 — 干净重建的诊断探针（前置运行，VM/shim 代码之前）
 * 日志写 chrome.storage.local.__syDiagLog（可从 LevelDB 落盘读出）。
 * 修复点：
 *  - storage.local get/set 对 scr:* 条目剥毒键（config/custom/props 里的 SW 全局泄漏）
 *  - navigator.serviceWorker.onmessage setter 代理（VM 真实接消息点；纯 getter/setter，
 *    不加 addEventListener —— 避免 v3 的双派发）
 *  - chrome.userScripts.register/update/unregister 记录（id/matches/codeLen/错误）
 *  - BroadcastChannel.prototype.postMessage clone 预检（报真实错误）
 */
;(function () {
    try {
        if (self.__syDiagV4) return;
        self.__syDiagV4 = true;
        var __log = [];
        var __logTimer = null;
        function syDiagLog(entry) {
            try {
                entry.t = Date.now();
                __log.push(entry);
                if (__log.length > 200) __log.splice(0, __log.length - 200);
                if (__logTimer) return;
                __logTimer = setTimeout(function () {
                    __logTimer = null;
                    try { chrome.storage.local.set({ __syDiagLog: __log.slice(-200) }); } catch (e) {}
                }, 400);
            } catch (e) {}
        }
        self.__syDiagLogPush = syDiagLog;
        syDiagLog({ k: "v4-installed" });

        // ---- 1) scr:* 存储净化（防 ParseScript 消息毒物持久化/读回） ----
        var POISON_KEYS = ["clients", "chrome", "browser", "cookieStore", "registration", "serviceWorker", "tld", "skipWaiting", "onactivate", "onfetch", "oninstall", "onmessage", "location", "navigator", "performance", "crypto", "caches", "indexedDB", "fetch", "close", "console"];
        function syIsPoisonKey(k) { return POISON_KEYS.indexOf(k) >= 0 || String(k).indexOf("__sy") === 0; }
        function syStripPoison(obj) {
            var n = 0;
            if (!obj || typeof obj !== "object") return 0;
            for (var k in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, k) && syIsPoisonKey(k)) {
                    try { delete obj[k]; n++; } catch (e) {}
                }
            }
            return n;
        }
        function syStripEntry(v) {
            if (!v || typeof v !== "object") return 0;
            return syStripPoison(v.config) + syStripPoison(v.custom) + syStripPoison(v.props);
        }
        try {
            var st = self.chrome && self.chrome.storage && self.chrome.storage.local;
            if (st) {
                var origSet = st.set;
                st.set = function (items, cb) {
                    try {
                        if (items && typeof items === "object") {
                            for (var k in items) {
                                if (String(k).indexOf("scr:") === 0) {
                                    var n = syStripEntry(items[k]);
                                    if (n) { syDiagLog({ k: "set-strip", key: k, n: n }); }
                                }
                            }
                        }
                    } catch (eS) {}
                    return origSet.apply(this, arguments);
                };
                var origGet = st.get;
                st.get = function () {
                    var args = Array.prototype.slice.call(arguments);
                    var r = origGet.apply(this, args);
                    if (r && typeof r.then === "function") {
                        return r.then(function (res) {
                            try {
                                if (res && typeof res === "object") {
                                    for (var k in res) {
                                        if (String(k).indexOf("scr:") === 0) {
                                            var n = syStripEntry(res[k]);
                                            if (n) syDiagLog({ k: "get-strip", key: k, n: n });
                                        }
                                    }
                                }
                            } catch (eG) {}
                            return res;
                        });
                    }
                    return r;
                };
            }
        } catch (e) { syDiagLog({ k: "storage-wrap-err", msg: String(e) }); }

        // ---- 2) chrome.userScripts 全量记录 ----
        try {
            var us = self.chrome && self.chrome.userScripts;
            if (us) {
                ["register", "update", "unregister"].forEach(function (m) {
                    var orig = us[m];
                    if (typeof orig !== "function") return;
                    us[m] = function () {
                        var args = arguments;
                        try {
                            var info = [];
                            for (var i = 0; i < args.length; i++) {
                                var a = args[i];
                                if (a && typeof a === "object") {
                                    if (typeof a.length === "number") {
                                        for (var j = 0; j < a.length; j++) {
                                            var e2 = a[j] || {};
                                            var jsLen = 0, files = [];
                                            try {
                                                (e2.js || []).forEach(function (x) {
                                                    if (x && x.code) jsLen += x.code.length;
                                                    if (x && x.file) files.push(x.file);
                                                });
                                            } catch (e5) {}
                                            info.push({ id: e2.id, matches: e2.matches, codeLen: jsLen, files: files });
                                        }
                                    } else {
                                        info.push({ ids: a.ids });
                                    }
                                }
                            }
                            syDiagLog({ k: "us." + m, args: info });
                        } catch (e1) { syDiagLog({ k: "us." + m + ".argerr", msg: String(e1) }); }
                        var r = orig.apply(this, args);
                        try {
                            if (r && typeof r.then === "function") {
                                r.then(function () { syDiagLog({ k: "us." + m + ".ok" }); },
                                       function (err) { syDiagLog({ k: "us." + m + ".ERR", msg: String(err && err.message || err).slice(0, 200) }); });
                            }
                        } catch (e4) {}
                        return r;
                    };
                });
            } else {
                syDiagLog({ k: "no-chrome.userScripts" });
            }
        } catch (e) { syDiagLog({ k: "us-wrap-err", msg: String(e) }); }

        // ---- 3) navigator.serviceWorker.onmessage 代理（VM 的页面→SW 接收点） ----
        try {
            var sw = navigator.serviceWorker;
            if (sw) {
                var __origSwOnMsg = null;
                function sySwWrap(evt) {
                    try {
                        var d = evt && evt.data;
                        var env = d && d.msg ? d.msg : d;
                        var cmd = env && (typeof env === "object" ? env.cmd : (function () { try { return JSON.parse(env).cmd; } catch (e) { return "?"; } })());
                        syDiagLog({ k: "sw-msg", cmd: typeof cmd === "string" ? cmd : String(cmd), from: evt && evt.data && evt.data.src ? String(evt.data.src.url || "").slice(0, 60) : "?" });
                    } catch (e) {}
                    return __origSwOnMsg ? __origSwOnMsg.apply(this, arguments) : undefined;
                }
                Object.defineProperty(sw, "onmessage", {
                    configurable: true,
                    get: function () { return __origSwOnMsg ? sySwWrap : null; },
                    set: function (v) { __origSwOnMsg = (v && typeof v === "function") ? v : null; }
                });
            }
        } catch (e) { syDiagLog({ k: "sw-wrap-err", msg: String(e) }); }

        // ---- 4) BroadcastChannel postMessage clone 预检 ----
        try {
            if (self.BroadcastChannel) {
                var origPost = self.BroadcastChannel.prototype.postMessage;
                self.BroadcastChannel.prototype.postMessage = function (msg) {
                    try {
                        structuredClone(msg);
                    } catch (e) {
                        var diag = "[sy-diag] BC clone fail: " + e.message;
                        syDiagLog({ k: "bc-clone-fail", msg: String(e.message).slice(0, 200) });
                        var w = new Error(diag);
                        w.name = "DataCloneError";
                        throw w;
                    }
                    return origPost.apply(this, arguments);
                };
            }
        } catch (e) {}
    } catch (e) {}
})();
