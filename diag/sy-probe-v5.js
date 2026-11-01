/* sy-diag v5 — 修正监听点的诊断探针（前置运行）
 * v4 教训：VM SW 接收页面命令走 chrome.runtime.sendMessage → 宿主 routeSendMessage →
 * __syOnMessageHandlers eval 派发（每条消息过 __syNormalizeMsg），不经过
 * navigator.serviceWorker.onmessage（那是原生 postMessage 通道，此环境无人用）。
 * 日志写 chrome.storage.local.__syDiagLog（LevelDB 可读）。
 * 覆盖：
 *  1. scr:* 存储净化（get/set 剥毒键）
 *  2. chrome.userScripts register/update/unregister 全记录
 *  3. BroadcastChannel postMessage clone 预检
 *  4. __syNormalizeMsg 陷阱：记录每条派发命令 cmd + sender.url + 载荷大小
 */
;(function () {
    try {
        if (self.__syDiagV5) return;
        self.__syDiagV5 = true;
        var __log = [];
        var __logTimer = null;
        function syDiagLog(entry) {
            try {
                entry.t = Date.now();
                __log.push(entry);
                if (__log.length > 300) __log.splice(0, __log.length - 300);
                if (__logTimer) return;
                __logTimer = setTimeout(function () {
                    __logTimer = null;
                    try { chrome.storage.local.set({ __syDiagLog: __log.slice(-300) }); } catch (e) {}
                }, 400);
            } catch (e) {}
        }
        self.__syDiagLogPush = syDiagLog;
        syDiagLog({ k: "v9-installed" });

        // ---- 1) scr:* 存储净化 ----
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
                                var ks = String(k);
                                if (ks.indexOf("scr:") === 0) {
                                    var n = syStripEntry(items[k]);
                                    if (n) syDiagLog({ k: "set-strip", key: k, n: n });
                                } else if (ks.indexOf("__syRouteResp_") === 0) {
                                    // 宿主 sendResponse 落盘点：这里能看到命令的最终回包
                                    try {
                                        var rv = items[k] && items[k].resp;
                                        var rs = rv == null ? "null" : JSON.stringify(rv);
                                        syDiagLog({ k: "resp", key: ks, data: rs ? rs.slice(0, 700) : "?" });
                                    } catch (eR) {
                                        syDiagLog({ k: "resp", key: ks, data: "unserializable:" + eR });
                                    }
                                }
                            }
                        }
                    } catch (eS) {}
                    return origSet.apply(this, arguments);
                };
                var origGet = st.get;
                st.get = function () {
                    var r = origGet.apply(this, arguments);
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

        // ---- 3) BroadcastChannel postMessage clone 预检 ----
        try {
            if (self.BroadcastChannel) {
                var origPost = self.BroadcastChannel.prototype.postMessage;
                self.BroadcastChannel.prototype.postMessage = function (msg) {
                    try {
                        structuredClone(msg);
                    } catch (e) {
                        syDiagLog({ k: "bc-clone-fail", msg: String(e.message).slice(0, 200) });
                        var w = new Error("[sy-diag] BC clone fail: " + e.message);
                        w.name = "DataCloneError";
                        throw w;
                    }
                    return origPost.apply(this, arguments);
                };
            }
        } catch (e) {}

        // ---- 4) __syNormalizeMsg 陷阱：宿主派发每条命令都会过它 ----
        //       shim 在本探针之后才赋值该属性 → 用 accessor 陷阱捕获。
        try {
            var __normFn = null;
            Object.defineProperty(self, "__syNormalizeMsg", {
                configurable: true,
                get: function () {
                    if (!__normFn) return null;
                    return function (msg) {
                        try {
                            var cmd = msg && (msg.cmd || (msg.msg && msg.msg.cmd));
                            var size = 0;
                            try { size = JSON.stringify(msg).length; } catch (e2) { size = -1; }
                            var entry = { k: "cmd", cmd: cmd == null ? "?" : String(cmd), size: size };
                            try {
                                var d = msg && (msg.data != null ? msg.data : (msg.msg && msg.msg.data));
                                if (d != null) {
                                    var dStr = JSON.stringify(d);
                                    entry.data = dStr ? dStr.slice(0, 500) : String(dStr);
                                }
                            } catch (e3) {}
                            syDiagLog(entry);
                        } catch (e) {}
                        return __normFn.apply(this, arguments);
                    };
                },
                set: function (v) { __normFn = (v && typeof v === "function") ? v : null; syDiagLog({ k: "norm-set", fn: !!v }); }
            });
        } catch (e) { syDiagLog({ k: "norm-trap-err", msg: String(e) }); }

        // ---- 5) handlers 数组元素就地包装（不动属性，无 accessor 陷阱）：
        //     轮询 self.__syOnMessageHandlers，把每个未包装的 handler 函数
        //     替换为带日志的同语义包装 —— 记录命令回包值 / 同步抛错 / Promise
        //     拒绝堆栈。宿主 eval 读到的仍是同一数组（真实函数），派发不受影响。
        //     注意 v7 教训：绝不能对 __syOnMessageHandlers 本身装 accessor。
        try {
            setInterval(function () {
                try {
                    var arr = self.__syOnMessageHandlers;
                    if (!arr || !arr.length) return;
                    for (var i = 0; i < arr.length; i++) {
                        var fn = arr[i];
                        if (typeof fn !== "function" || fn.__syProbeWrapped) continue;
                        arr[i] = (function (orig) {
                            var wrapped = function (msg, sender, sendResponse) {
                                var cmd = "?";
                                try { cmd = String(msg && msg.cmd); } catch (e0) {}
                                var logResp = function (tag, v) {
                                    try {
                                        var s = v === undefined ? "undefined" : JSON.stringify(v);
                                        syDiagLog({ k: tag, cmd: cmd, len: s ? s.length : 0, data: s ? s.slice(0, 1600) : "?" });
                                    } catch (e) { syDiagLog({ k: tag, cmd: cmd, data: "unser:" + e }); }
                                };
                                var sr = function (resp) { logResp("resp-cb", resp); return sendResponse(resp); };
                                var r;
                                try { r = orig.call(this, msg, sender, sr); }
                                catch (eSync) {
                                    syDiagLog({ k: "h-throw", cmd: cmd, msg: String(eSync && eSync.message || eSync).slice(0, 400) });
                                    throw eSync;
                                }
                                if (r && typeof r.then === "function") {
                                    return r.then(
                                        function (v) { logResp("resp-promise", v); return v; },
                                        function (e) {
                                            syDiagLog({ k: "h-rej", cmd: cmd, msg: String(e && (e.stack || e.message) || e).slice(0, 800) });
                                            throw e;
                                        });
                                }
                                logResp("resp-sync", r);
                                return r;
                            };
                            wrapped.__syProbeWrapped = true;
                            return wrapped;
                        })(fn);
                    }
                } catch (e) {}
            }, 300);
        } catch (e) { syDiagLog({ k: "wrap-err", msg: String(e) }); }
    } catch (e) {}
})();
