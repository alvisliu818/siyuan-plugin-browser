// VM 存储 schema 取证:chrome.storage.local 全量 dump + 关键对象结构
(async () => {
    const bp = window.browserPlugin;
    if (!bp || !bp.diagEvalInSw) return "no diag";
    const host = bp.extensionHost;
    const vm = (host.list() || []).find(e => /violentmonkey|暴力猴/i.test(String(e.name || "")));
    if (!vm) return "VM not installed";
    const r = await bp.diagEvalInSw(vm.electronId, `chrome.storage.local.get(null).then(v => JSON.stringify(v)).catch(e => "ERR:" + e)`);
    if (r.err) return "eval err: " + r.err;
    const db = JSON.parse(r.value);
    const out = { keys: Object.keys(db), detail: {} };
    for (const k of Object.keys(db)) {
        const v = db[k];
        const t = typeof v;
        if (t === "string" && v.length > 120) out.detail[k] = "string(" + v.length + "): " + v.slice(0, 100);
        else if (v && typeof v === "object") {
            const ks = Object.keys(v);
            out.detail[k] = { type: Array.isArray(v) ? "array(" + v.length + ")" : "object", keys: ks.slice(0, 10) };
            if (k === "data" || k === "scripts") {
                // 深入一层
                for (const kk of ks.slice(0, 3)) {
                    const vv = v[kk];
                    out.detail[k]["." + kk] = vv && typeof vv === "object" ? Object.keys(vv).slice(0, 12) : typeof vv;
                }
            }
        } else out.detail[k] = v;
    }
    return JSON.stringify(out, null, 1);
})()
