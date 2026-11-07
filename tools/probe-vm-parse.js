// 活体验证:在 VM SW 内直接调它的 onMessage 处理器(ParseScript 命令)完成安装
(async () => {
    const bp = window.browserPlugin;
    if (!bp?.diagEvalInSw) return "no diag";
    const host = bp.extensionHost;
    const vm = (host.list() || []).find(e => /violentmonkey|暴力猴/i.test(String(e.name || "")));
    if (!vm) return "no VM";
    const code = '// ==UserScript==\n// @name         PROBE-direct-install\n// @version      1.0.0\n// @description  宿主直装验证\n// @match        *://127.0.0.1:18777/*\n// @grant        none\n// ==/UserScript==\nconsole.log("direct install ok");';
    const expr = `(async () => {
        const fns = self.__syOnMessageHandlers || [];
        if (!fns.length) return JSON.stringify({err: "no handlers"});
        const code = ${JSON.stringify(code)};
        const msg = {cmd: "ParseScript", data: {code: code, url: "http://127.0.0.1:18777/direct.user.js", from: "", require: [], cache: [], reloadTab: false, bumpDate: true}};
        return await new Promise((resolve) => {
            let done = false;
            const fin = (s) => { if (!done) { done = true; resolve(s); } };
            const sendResponse = (r) => fin("resp:" + JSON.stringify(r).slice(0, 300));
            setTimeout(() => fin("TIMEOUT"), 15000);
            for (const fn of fns) {
                try {
                    const r = fn(msg, {id: "(vm.electronId)", origin: "chrome-extension://bchcpcnhjelkpkdjbmbnikbamkjdeenb", url: "chrome-extension://bchcpcnhjelkpkdjbmbnikbamkjdeenb/confirm/index.html#probe", tlsChannelId: ""}, sendResponse);
                    if (r && r.then) r.then((x) => { if (!done) fin("async:" + JSON.stringify(x).slice(0, 300)); }).catch((e) => { if (!done) fin("ERR:" + e); });
                } catch (e) { fin("THROW:" + e); }
            }
        });
    })()`;
    const r = await bp.diagEvalInSw(vm.electronId, expr);
    return JSON.stringify(r, null, 1);
})()
