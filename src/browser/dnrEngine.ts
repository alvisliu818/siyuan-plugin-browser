// 网络层广告拦截引擎：解析 AdGuard 扩展自带的 declarativeNetRequest 规则集
// （filters/declarative/ruleset_N/ruleset_N.json），经 session.webRequest
// 阻塞式拦截（对齐 Chrome 的网络层过滤能力；Electron 无 DNR，这是等价实现）。
//
// 匹配器按规则分布优化（实测 53 个规则集 35 万条规则）：
//   - "||domain" 锚定 → hostname 后缀 Map，规则粒度 {all/paths, rts, dt}
//   - 其余（泛匹配/带约束）→ 约束分组正则（rts/dt 相同的规则合并编译，逐组
//     先查约束再跑正则）/ 富规则单条（regexFilter/urlFilter + initiator）
//
// ★ 约束完备性（2026-10-31 bidianer 误杀定案）：v1 忽略 resourceTypes（10 万条
//   规则带此约束）与 domainType（1.5 万条），rich 路径还丢 urlFilter —— 一条
//   initiatorDomains:["com"] + urlFilter:/assets/images/*.gif^ + resourceTypes:
//   ["image"] 的规则被放大成"拦 .com 来源的一切请求"，站点自家 CSS/JS 全灭。
//   本版补齐三个维度；excludedDomains / excludedInitiatorDomains /
//   requestMethods / tabIds 规则仍跳过（fail-open 计数）。

function dnrNodeMods(): { fs: any; path: any } {
    const req = (window as any).require;
    if (!req) throw new Error("node require unavailable");
    return { fs: req("fs"), path: req("path") };
}

/** Electron webRequest resourceType（camelCase）→ DNR resourceTypes（snake_case） */
const RT_MAP: Record<string, string> = {
    mainFrame: "main_frame",
    subFrame: "sub_frame",
    xhr: "xmlhttprequest",
    cspReport: "csp_report",
    webSocket: "websocket",
    webTransport: "webtransport",
};

interface DnrRule {
    all?: boolean;
    paths?: string[];
    rts?: Set<string> | null;
    dt?: string | null;
}

interface DnrDomainEntry {
    rules: DnrRule[];
}

interface RichRule {
    re: RegExp | null;      // regexFilter
    ufRe: RegExp | null;    // urlFilter 编译（rich 路径必须受 urlFilter 约束）
    initiator: string[] | null;
    rts: Set<string> | null;
    dt: string | null;
}

interface GenericGroup {
    rts: Set<string> | null;
    dt: string | null;
    srcs: string[];
    re: RegExp | null;
}

export interface DnrStats {
    loaded: boolean;
    loading: boolean;
    rulesets: number;
    blockRules: number;
    allowRules: number;
    genericRules: number;
    skippedRules: number;
    blocked: number;
}

const sameSite = (a: string, b: string): boolean => {
    const strip = (s: string) => (s.startsWith("www.") ? s.slice(4) : s);
    const x = strip(a), y = strip(b);
    return x === y || x.endsWith("." + y) || y.endsWith("." + x);
};

export class DnrBlocker {
    private blockDom = new Map<string, DnrDomainEntry>();
    private allowDom = new Map<string, DnrDomainEntry>();
    private blockRich: RichRule[] = [];
    private allowRich: RichRule[] = [];
    private blockGroups: GenericGroup[] = [];
    private allowGroups: GenericGroup[] = [];
    private blockGroupMap = new Map<string, GenericGroup>();
    private allowGroupMap = new Map<string, GenericGroup>();
    private genericBlockCount = 0;
    private genericAllowCount = 0;
    private skipped = 0;
    private loading = false;
    private loaded = false;
    private blockedCount = 0;
    private lastBlockLog = 0;

    get stats(): DnrStats {
        return {
            loaded: this.loaded,
            loading: this.loading,
            rulesets: this.rulesetCount,
            blockRules: this.blockDom.size,
            allowRules: this.allowDom.size,
            genericRules: this.genericBlockCount + this.genericAllowCount,
            skippedRules: this.skipped,
            blocked: this.blockedCount,
        };
    }
    private rulesetCount = 0;

    private loadingPromise: Promise<void> | null = null;

    /** 惰性加载（幂等）：extPath = AdGuard 扩展目录 */
    load(extPath: string): Promise<void> {
        if (this.loaded || this.loading) return this.loadingPromise || Promise.resolve();
        this.loading = true;
        this.loadingPromise = (async () => {
            try {
                const { fs, path: pathMod } = dnrNodeMods();
                const dir = pathMod.join(extPath, "filters", "declarative");
                const entries = fs.readdirSync(dir).filter((d: string) => /^ruleset_\d+$/.test(d));
                for (const rs of entries) {
                    const file = pathMod.join(dir, rs, rs + ".json");
                    if (!fs.existsSync(file)) continue;
                    try {
                        const rules = JSON.parse(fs.readFileSync(file, "utf8"));
                        this.rulesetCount++;
                        this.ingest(rules);
                    } catch {}
                }
                this.finalizeGroups(this.blockGroupMap, this.blockGroups);
                this.finalizeGroups(this.allowGroupMap, this.allowGroups);
                this.loaded = true;
                console.log("[browser-plugin] DNR 规则集加载完成:", JSON.stringify(this.stats));
            } catch (e) {
                console.warn("[browser-plugin] DNR 规则集加载失败:", e);
            } finally {
                this.loading = false;
            }
        })();
        return this.loadingPromise;
    }

    private ingest(rules: any[]): void {
        for (const r of rules) {
            try {
                const action = r.action || {};
                const cond = r.condition || {};
                const isAllow = action.type === "allow";
                if (action.type !== "block" && !isAllow) { this.skipped++; continue; }
                if (cond.excludedDomains && cond.excludedDomains.length) { this.skipped++; continue; }
                if (cond.excludedInitiatorDomains && cond.excludedInitiatorDomains.length) { this.skipped++; continue; }
                if (cond.tabIds || cond.requestMethods) { this.skipped++; continue; }
                let uf = String(cond.urlFilter || "");
                if (uf === "dummy.rule.adguard.com") { this.skipped++; continue; } // 占位规则
                const rts = Array.isArray(cond.resourceTypes) && cond.resourceTypes.length
                    ? new Set(cond.resourceTypes.map((x: any) => String(x)))
                    : null;
                const dt = cond.domainType === "firstParty" || cond.domainType === "thirdParty" ? cond.domainType : null;
                const iniRaw = cond.initiatorDomains || cond.domains || null;
                const hasIni = !!iniRaw && iniRaw.length > 0;
                let re: RegExp | null = null;
                if (cond.regexFilter) {
                    try { re = new RegExp(String(cond.regexFilter), cond.isUrlFilterCaseSensitive ? "" : "i"); }
                    catch { this.skipped++; continue; } // RE2 语法 JS 不兼容的 fail-open
                }
                const ufRe = uf ? this.compileUf(uf) : null;
                if (uf && !ufRe) { this.skipped++; continue; }
                // 富规则：regexFilter / initiator / 带约束的 urlFilter —— 逐条判定
                if (re || hasIni || rts || dt) {
                    const entry: RichRule = {
                        re,
                        ufRe: uf ? ufRe : null,
                        initiator: hasIni ? iniRaw.map((d: string) => String(d).toLowerCase()) : null,
                        rts,
                        dt,
                    };
                    (isAllow ? this.allowRich : this.blockRich).push(entry);
                    continue;
                }
                if (!uf) { this.skipped++; continue; }
                if (uf.startsWith("||")) {
                    const rest = uf.slice(2);
                    // domain = 至第一个 ^ / / 或结尾；其后为路径段
                    const cut = rest.search(/[\^/]/);
                    const domain = (cut < 0 ? rest : rest.slice(0, cut)).toLowerCase();
                    if (!domain || domain.includes("*")) { this.skipped++; continue; }
                    let pathPart = cut < 0 ? "" : rest.slice(cut); // 可能以 ^ 开头
                    const entry = this.allowDom.has(domain) || this.blockDom.has(domain)
                        ? (isAllow ? this.allowDom : this.blockDom).get(domain)!
                        : ((isAllow ? this.allowDom : this.blockDom).set(domain, { rules: [] }), (isAllow ? this.allowDom : this.blockDom).get(domain)!);
                    const rule: DnrRule = { rts, dt };
                    if (!pathPart || pathPart === "^") {
                        rule.all = true;
                    } else if (!pathPart.slice(1).includes("*")) {
                        // "||d^/p" 或 "||d^p" 或 "||d/p"：^ 视作路径分隔符；尾 * = 前缀匹配
                        const norm = ("/" + pathPart.replace(/^\^/, "").replace(/\^/g, "/")).replace(/\/{2,}/g, "/");
                        rule.paths = [norm.replace(/\*+$/, "").replace(/\/{2,}/g, "/")];
                    } else {
                        // 路径中段含 *：转约束分组正则池（domain 字面 + 其余走通配转换）
                        this.addGroupSource(isAllow, escapeRe(domain) + this.dnrToRegexSource(pathPart.replace(/^\^/, "")), rts, dt);
                        continue;
                    }
                    entry.rules.push(rule);
                } else {
                    // 泛匹配：按约束签名分组编译（^ → 分隔符类，* → 任意，| → 锚）
                    this.addGroupSource(isAllow, this.dnrToRegexSource(uf), rts, dt);
                }
            } catch {
                this.skipped++;
            }
        }
    }

    /** 约束签名分组（rts/dt 相同的规则合并编译，逐组先查约束再跑正则） */
    private addGroupSource(isAllow: boolean, src: string, rts: Set<string> | null, dt: string | null): void {
        const key = (rts ? Array.from(rts).sort().join(",") : "*") + "|" + (dt || "*");
        const map = isAllow ? this.allowGroupMap : this.blockGroupMap;
        let g = map.get(key);
        if (!g) {
            g = { rts, dt, srcs: [], re: null };
            map.set(key, g);
        }
        g.srcs.push(src);
        if (isAllow) this.genericAllowCount++; else this.genericBlockCount++;
    }

    private finalizeGroups(map: Map<string, GenericGroup>, out: GenericGroup[]): void {
        for (const g of map.values()) {
            try { g.re = new RegExp(g.srcs.join("|"), "i"); } catch { g.re = null; }
            if (g.re) out.push(g);
        }
        map.clear();
    }

    private compileUf(uf: string): RegExp | null {
        // urlFilter = URL 任意位置子串匹配；||/| 锚语义简化处理（rich 规则量小）
        const s = uf.startsWith("||") ? uf.slice(2) : uf;
        try { return new RegExp(this.dnrToRegexSource(s), "i"); } catch { return null; }
    }

    private escapeRe(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /** DNR urlFilter → 正则源（^ = 非字母数字分隔符或结尾，* = 任意，| → 锚） */
    private dnrToRegexSource(uf: string): string {
        let s = "";
        for (let i = 0; i < uf.length; i++) {
            const ch = uf[i];
            if (ch === "^") s += "(?:[^a-z0-9._%-]|$)";
            else if (ch === "*") s += ".*";
            else if (ch === "|") s += i === 0 ? "^" : "$";
            else s += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        return s;
    }

    /** 请求判定：true = 阻断（allow 优先于 block；initiator/referrer + rts/dt 全约束） */
    shouldBlock(url: string, resourceType?: string, referrer?: string): boolean {
        if (!this.loaded) return false;
        let host = "";
        let path = "/";
        let refHost = "";
        try {
            const u = new URL(url);
            if (u.protocol !== "http:" && u.protocol !== "https:") return false;
            host = u.hostname.toLowerCase();
            path = u.pathname + u.search;
            if (referrer && /^https?:\/\//i.test(referrer)) refHost = new URL(referrer).hostname.toLowerCase();
        } catch {
            return false;
        }
        const rtDnr = resourceType ? (RT_MAP[resourceType] || resourceType) : null;
        const rtsOk = (set: Set<string> | null): boolean => !set || !rtDnr || set.has(rtDnr);
        const dtOk = (dt: string | null): boolean => {
            if (!dt) return true;
            if (!refHost) return false; // 有 firstParty/thirdParty 条件但拿不到 referrer → fail-open
            return dt === "firstParty" ? sameSite(refHost, host) : !sameSite(refHost, host);
        };
        // 域名后缀匹配：host 全名 → 逐级剥标签（a.b.c → c → b.c → a.b.c）
        const labels = host.split(".");
        const domHit = (map: Map<string, DnrDomainEntry>): boolean => {
            for (let cut = 0; cut < labels.length; cut++) {
                const entry = map.get(labels.slice(cut).join("."));
                if (!entry) continue;
                for (const rl of entry.rules) {
                    const pathOk = rl.all || (rl.paths && rl.paths.some((p) => path.startsWith(p) || path === p));
                    if (pathOk && rtsOk(rl.rts) && dtOk(rl.dt)) return true;
                }
            }
            return false;
        };
        const richHit = (list: RichRule[]): boolean => {
            for (const e of list) {
                if (!rtsOk(e.rts) || !dtOk(e.dt)) continue;
                if (e.re && !e.re.test(url)) continue;
                if (e.ufRe && !e.ufRe.test(url)) continue;
                if (e.initiator) {
                    // 有 initiator 条件但拿不到 referrer → fail-open（不匹配）
                    if (!refHost) continue;
                    let hit = false;
                    for (const d of e.initiator) {
                        if (refHost === d || refHost.endsWith("." + d)) { hit = true; break; }
                    }
                    if (!hit) continue;
                }
                return true;
            }
            return false;
        };
        const groupHit = (groups: GenericGroup[]): boolean => {
            for (const g of groups) {
                if (!rtsOk(g.rts) || !dtOk(g.dt)) continue;
                if (g.re && g.re.test(url)) return true;
            }
            return false;
        };
        if (domHit(this.allowDom) || richHit(this.allowRich) || groupHit(this.allowGroups)) return false; // 例外规则优先
        let blocked = domHit(this.blockDom) || richHit(this.blockRich) || groupHit(this.blockGroups);
        if (blocked) {
            this.blockedCount++;
            const now = Date.now();
            if (now - this.lastBlockLog > 5000) {
                this.lastBlockLog = now;
                console.debug("[browser-plugin] DNR 拦截:", host, "累计", this.blockedCount);
            }
        }
        return blocked;
    }
}

export const dnrBlocker = new DnrBlocker();
