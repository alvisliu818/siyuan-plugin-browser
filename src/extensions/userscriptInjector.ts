import type { IWebviewTag } from "../types";
import { matchesUrlPattern } from "./extensionHost";
import { ensureExtensionWorld, evalInExtensionWorldBridge, evalInSwBridge } from "./cs-runtime";
import { evalInExtensionWorld } from "./sw-bridge";

/** 注入所需的扩展信息（与 cs-runtime 的 ICsExtInfo 结构对齐，弱类型避免循环依赖） */
interface IUsExtInfo {
    electronId: string;
    path: string;
    name: string;
    version: string;
    defaultLocale: string;
    contentScripts: Array<{ matches: string[]; js: string[]; css: string[] }>;
}

/**
 * chrome.userScripts 适配层（Tampermonkey 等 MV3 用户脚本扩展的宿主支撑）。
 *
 * 背景：Electron 44 原生有 chrome.scripting 但没有 chrome.userScripts（MV3
 * 用户脚本注入的官方通道）。Tampermonkey 5.x 的 SW 探测不到该 API 即进入
 * "无法运行脚本" 降级模式（提示开发者模式 FAQ Q209），所有脚本失效——
 * 宿主补 userScripts API 才能让真扩展跑起来（用户诉求：适配扩展本身，
 * 而不是在插件里自建脚本引擎）。
 *
 * 分工：
 * - SW 侧（extensionHost.injectBackgroundShims 的垫片 v16）：按 Chrome 契约实现
 *   chrome.userScripts 的 register/getScripts/unregister/update/reset/
 *   configureWorld。注册表存 SW 内存 + chrome.storage.local 持久化（SW 重启
 *   后 getScripts 仍可答）；每次变更把增量 ops 推入 self.__syUserScriptsOutbox。
 * - 宿主侧（本文件）：拉取 outbox 维护注册表副本；页面 dom-ready 时把命中
 *   URL 的脚本代码注入该页的扩展自建世界（cs-runtime）——该世界的
 *   chrome.runtime.sendMessage 已由 v15 垫片路由桥接到 SW，满足 TM
 *   configureWorld({messaging:true}) 的消息语义；GM_* API 由 TM 自己的
 *   bootstrap 实现，宿主不做任何脚本功能实现。
 *
 * 语义取舍（v1）：
 * - 所有 registered 脚本统一注入自建世界（USER_SCRIPT 语义）；world:"MAIN"
 *   的条目同样在该世界执行（多一层 chrome.* 可用性，无碍 @grant none 脚本）。
 * - 时序对齐 dom-ready（≈document_idle）；@run-at document-start 的脚本晚于
 *   原生时机执行 —— 与自建世界内容脚本的既有折衷一致。
 */

interface IUserScriptEntry {
    id?: string;
    matches?: string[];
    excludeMatches?: string[];
    js?: Array<{ code?: string }>;
    [key: string]: any;
}

export class UserscriptInjector {
    /** electronId → (scriptId → 完整注册条目，含 js code) */
    private regs = new Map<string, Map<string, any>>();
    /** electronId → 上次对账到的注册表版本号（SW 垫片自增，见 extensionHost 垫片 v17） */
    private versions = new Map<string, number>();

    /** 注册脚本总数（诊断用） */
    stats(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [id, m] of this.regs) out[id] = m.size;
        return out;
    }

    /**
     * 与扩展 SW 的 userScripts 注册表对账：垫片维护自增版本号（内存+storage
     * 持久化，SW 启动即水合），宿主版本不一致时拉全量替换副本。
     * evalInSwBridge 内部有唤醒/兜底通道；SW 休眠时失败静默（下次 dom-ready 再试）。
     */
    async drain(electronId: string): Promise<void> {
        // 1) 读版本号（廉价，每次 dom-ready 都做）
        const verExpr =
            "(JSON.stringify({ ver: self.__syUserScriptsVersion || 0, hydrated: typeof self.__syUserScriptsReg === 'object' }))";
        let verRes: { value?: any; err?: string };
        try {
            verRes = await evalInSwBridge({ electronId } as any, verExpr);
        } catch {
            return;
        }
        if (!verRes || verRes.err || !verRes.value) return;
        let verData: { ver?: number; hydrated?: boolean };
        try {
            verData = JSON.parse(String(verRes.value));
        } catch {
            return;
        }
        const swVer = Number(verData?.ver || 0);
        if (this.versions.get(electronId) === swVer && this.regs.has(electronId)) return;
        // 2) 版本变化（或宿主首次见到）→ 拉全量注册表替换副本
        const regExpr = "(async () => { try {" +
            " if (typeof self.__syUserScriptsReg !== 'object' || !self.__syUserScriptsReg) return JSON.stringify({ ok: false });" +
            " return JSON.stringify({ ok: true, reg: self.__syUserScriptsReg });" +
            " } catch (e) { return JSON.stringify({ ok: false, err: String(e) }); } })()";
        let regRes: { value?: any; err?: string };
        try {
            regRes = await evalInSwBridge({ electronId } as any, regExpr);
        } catch {
            return;
        }
        if (!regRes || regRes.err || !regRes.value) return;
        let regData: { ok?: boolean; reg?: Record<string, any> };
        try {
            regData = JSON.parse(String(regRes.value));
        } catch {
            return;
        }
        if (!regData?.ok || !regData.reg || typeof regData.reg !== "object") return;
        this.regs.set(electronId, new Map(Object.entries(regData.reg)));
        this.versions.set(electronId, swVer);
        console.log(`[browser-plugin] userScripts registry reconciled (${electronId.slice(0, 8)}): ${Object.keys(regData.reg).length} scripts @ v${swVer}`);
    }

    /**
     * dom-ready 注入入口：把该页命中的所有已注册用户脚本（含 TM 自身的
     * page.js/content.js 引导包）注入扩展自建世界。
     */
    async injectForPage(webview: IWebviewTag, url: string): Promise<void> {
        if (!url || !/^https?:\/\//i.test(url)) return;
        const nativeExts = this.listNativeExts();
        for (const ext of nativeExts) {
            const electronId = ext.electronId;
            await this.drain(electronId);
            const scripts = this.regs.get(electronId);
            if (!scripts || scripts.size === 0) continue;
            // 世界可能不存在（油猴类扩展无静态 content script，cs-runtime 的
            // installExt 会跳过建世界）—— 注入前确保世界 + chrome.* 垫片就绪
            try {
                await ensureExtensionWorld(webview, ext as any);
            } catch (e) {
                console.warn(`[browser-plugin] userScript world ensure failed (${ext.name}):`, String((e as any)?.message || e).slice(0, 120));
                continue;
            }
            for (const entry of (scripts.values() as IterableIterator<IUserScriptEntry>)) {
                if (!entry || !entry.id) continue;
                if (!userScriptMatches(entry, url)) continue;
                const code = (entry.js || [])
                    .map((j) => {
                        // js 条目两种形态：{code}（注册时内联）与 {file}（真 Chrome 在
                        // 注入时才读文件）。TM 5.5.1 的 page/content 引导包用 file 形式
                        // 注册 —— 只认 code 会让引导静默不注入（面板"no access"）。
                        if (j && typeof j.code === "string" && j.code) return j.code;
                        const file = j && (j as any).file;
                        return file ? readExtFile(ext.path, String(file)) : "";
                    })
                    .filter(Boolean)
                    .join("\n;\n");
                if (!code) continue;
                const wrapped = "(function(){\n" + code + "\n})()";
                let r = await evalInExtensionWorldBridge(webview, electronId, wrapped).catch(
                    () => ({ ok: false, error: "bridge failed" }) as { ok: boolean; error?: string }
                );
                if (!r.ok) {
                    // flat CDP 通道失效（跨进程导航后 contextId 变化等）→ HTTP /json 兜底
                    r = await evalInExtensionWorld(webview, electronId, wrapped);
                }
                if (r.ok) {
                    console.log(`[browser-plugin] userScript "${entry.id}" injected @ ${url.slice(0, 80)}`);
                } else {
                    console.warn(`[browser-plugin] userScript "${entry.id}" inject failed @ ${url.slice(0, 80)}:`, r.error);
                }
            }
        }
    }

    /** 已启用且原生加载的扩展信息（由 ExtensionHost 注入提供） */
    private nativeExtsProvider: () => IUsExtInfo[] = () => [];
    setNativeIdProvider(fn: () => IUsExtInfo[]): void {
        this.nativeExtsProvider = fn;
    }

    private listNativeExts(): IUsExtInfo[] {
        try {
            return this.nativeExtsProvider() || [];
        } catch {
            return [];
        }
    }
}

/** 读扩展目录下的文件（userScripts {file} 形态注册的脚本代码）；失败返回空串 */
function readExtFile(extPath: string, rel: string): string {
    try {
        const req = (window as any).require;
        const fs = req("fs");
        const path = req("path");
        const abs = path.join(extPath, String(rel).replace(/^\/+/, ""));
        if (!fs.existsSync(abs)) return "";
        return fs.readFileSync(abs, "utf8");
    } catch {
        return "";
    }
}

/** userScripts 注册条目的 URL 匹配：matches/excludeMatches（match pattern） */
function userScriptMatches(entry: any, rawUrl: string): boolean {    const matches: string[] = entry.matches || [];
    const excludeMatches: string[] = entry.excludeMatches || [];
    if (excludeMatches.some((p) => safePattern(p, rawUrl))) return false;
    return matches.some((p) => safePattern(p, rawUrl));
}

function safePattern(pattern: string, rawUrl: string): boolean {
    try {
        return matchesUrlPattern(pattern, rawUrl);
    } catch {
        return false;
    }
}
