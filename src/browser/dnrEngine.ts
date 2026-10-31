// 网络层广告拦截引擎：解析 AdGuard 扩展自带的 declarativeNetRequest 规则集
// （filters/declarative/ruleset_N/ruleset_N.json），经 session.webRequest
// 阻塞式拦截（对齐 Chrome 的网络层过滤能力；Electron 无 DNR，这是等价实现）。
//
// 匹配器按规则分布优化（实测 5 个默认规则集共 28.3 万条 block 规则）：
//   - 98.7% 是 "||domain" 锚定 → hostname 后缀 Map，O(域名标签数)/请求
//   - 3.5k 泛匹配（路径/通配）→ 编译为正则（上限防御）
//   - initiator 条件/regexFilter 规则占比 <0.5% → v1 跳过（fail-open，计数）
// allow 规则优先于 block（AdGuard 例外/自放行）。

function dnrNodeMods(): { fs: any; path: any } {
    const req = (window as any).require;
    if (!req) throw new Error("node require unavailable");
    return { fs: req("fs"), path: req("path") };
}

interface DnrDomainEntry {
    all?: boolean;          // ||domain^（主机与全部路径）
    paths?: string[];       // ||domain^path / ||domain/path（路径前缀）
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

export class DnrBlocker {
    private blockDom = new Map<string, DnrDomainEntry>();
    private allowDom = new Map<string, DnrDomainEntry>();
    private blockGenRe: RegExp | null = null;
    private allowGenRe: RegExp | null = null;
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
                const map = isAllow ? this.allowDom : this.blockDom;
                // 富规则：regexFilter（177 条）与 initiator 条件（1,063 条）——按
                // referrer/正则逐条判定（量小，逐条正则可接受）
                const iniRaw = cond.initiatorDomains || cond.domains || null;
                const hasIni = !!iniRaw && iniRaw.length > 0;
                let re: RegExp | null = null;
                if (cond.regexFilter) {
                    try { re = new RegExp(String(cond.regexFilter), cond.isUrlFilterCaseSensitive ? "" : "i"); }
                    catch { this.skipped++; continue; } // RE2 语法 JS 不兼容的 fail-open
                }
                if (re || hasIni) {
                    const entry = {
                        re,
                        initiator: hasIni ? iniRaw.map((d: string) => String(d).toLowerCase()) : null,
                    };
                    (isAllow ? this.allowRich : this.richBlock).push(entry);
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
                    const entry = map.get(domain) || (map.set(domain, {}), map.get(domain)!);
                    if (!pathPart || pathPart === "^") {
                        entry.all = true;
                    } else if (!pathPart.slice(1).includes("*")) {
                        // "||d^/p" 或 "||d^p" 或 "||d/p"：^ 视作路径分隔符；尾 * = 前缀匹配
                        const norm = ("/" + pathPart.replace(/^\^/, "").replace(/\^/g, "/")).replace(/\/{2,}/g, "/");
                        (entry.paths || (entry.paths = [])).push(norm.replace(/\*+$/, "").replace(/\/{2,}/g, "/"));
                    } else {
                        // 路径中段含 *：转正则池（domain 字面 + 其余走通配转换）
                        if (!isAllow) this.addGenericSource(escapeRe(domain) + this.dnrToRegexSource(pathPart.replace(/^\^/, "")));
                        else this.skipped++;
                    }
                } else {
                    // 泛匹配：编译为正则（^ → 分隔符类，* → 任意串，| → 锚）
                    if (isAllow) this.genericAllowCount++; else this.genericBlockCount++;
                    if (!isAllow) this.addGenericSource(this.dnrToRegexSource(uf));
                }
            } catch {
                this.skipped++;
            }
        }
    }

    private escapeRe(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private genericRe: RegExp | null = null;
    private genericSrcs: string[] = [];
    private richBlock: Array<{ re: RegExp | null; initiator: string[] | null }> = [];
    private allowRich: Array<{ re: RegExp | null; initiator: string[] | null }> = [];
    private addGenericSource(reSrc: string): void {
        this.genericSrcs.push(reSrc);
        if (this.genericSrcs.length >= 4000 && !this.genericRe) this.rebuildGeneric();
    }
    private rebuildGeneric(): void {
        try {
            this.genericRe = new RegExp(this.genericSrcs.join("|"), "i");
        } catch {
            this.genericRe = null;
        }
    }
    /** DNR urlFilter → 正则源（^ = 非字母数字分隔符或结尾，* = 任意，|| 已在上游分流） */
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

    /** 请求判定：true = 阻断（allow 优先于 block；initiator 按 referrer 判定） */
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
        // 域名后缀匹配：host 全名 → 逐级剥标签（a.b.c → c → b.c → a.b.c）
        const labels = host.split(".");
        const domHit = (map: Map<string, DnrDomainEntry>): boolean => {
            for (let cut = 0; cut < labels.length; cut++) {
                const entry = map.get(labels.slice(cut).join("."));
                if (entry && (entry.all || (entry.paths && entry.paths.some((p) => path.startsWith(p) || path === p)))) return true;
            }
            return false;
        };
        const richHit = (list: Array<{ re: RegExp | null; initiator: string[] | null }>): boolean => {
            for (const e of list) {
                if (e.re && !e.re.test(url)) continue;
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
        if (domHit(this.allowDom) || richHit(this.allowRich)) return false;   // 例外规则优先
        let blocked = domHit(this.blockDom) || richHit(this.richBlock);
        if (!blocked && this.genericRe && this.genericRe.test(url)) blocked = true;
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
