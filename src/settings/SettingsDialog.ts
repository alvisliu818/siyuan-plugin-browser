import { Dialog, showMessage } from "siyuan";
import type { SettingsStore } from "../storage/settingsStore";
import type { BrowserSettings, DownloadTarget, ProxyMode } from "../types";
import { SEARCH_ENGINES } from "../constants";
import { listNotebooks } from "../browser/excerpt";

/** 设置对话框 */
export class SettingsDialog {
    private store: SettingsStore;
    private i18n: Record<string, string>;
    private dialog?: Dialog;

    constructor(store: SettingsStore, i18n: Record<string, string>) {
        this.store = store;
        this.i18n = i18n;
    }

    open(): void {
        const s = this.store.get();
        this.buildContent(s).then((content) => {
            this.dialog = new Dialog({
                title: this.i18n.settings,
                content,
                width: "560px",
            });
            // 限制对话框最大高度并让内容区滚动，避免撑满屏幕
            requestAnimationFrame(() => {
                const dlg = this.dialog?.element;
                if (dlg) {
                    const wrapper = dlg.querySelector(".b3-dialog__container") as HTMLElement;
                    if (wrapper) {
                        wrapper.style.maxHeight = "80vh";
                        wrapper.style.display = "flex";
                        wrapper.style.flexDirection = "column";
                    }
                    const body = dlg.querySelector(".b3-dialog__body") as HTMLElement;
                    if (body) {
                        body.style.maxHeight = "70vh";
                        body.style.overflowY = "auto";
                        body.style.padding = "16px 24px";
                    }
                }
                this.bindEvents(s);
            });
        });
    }

    private async buildContent(s: BrowserSettings): Promise<string> {
        const engineOptions = SEARCH_ENGINES.map(
            (e) => `<option value="${e.id}" ${e.id === s.searchEngine ? "selected" : ""}>${e.name}</option>`
        ).join("");
        const customUrlRow =
            s.searchEngine === "custom"
                ? `<div class="b3-form__row"><label>${this.i18n.custom}</label><input id="sb-custom-search" type="text" value="${escapeAttr(s.customSearchUrl)}" placeholder="https://example.com/search?q={q}"/></div>`
                : "";
        // 新标签页扩展下拉：列出声明了 chrome_url_overrides.newtab 的扩展
        let newTabExtOptions = "";
        try {
            const host = (window as any).browserPlugin?.extensionHost;
            for (const ext of host?.list?.() || []) {
                if (!ext.newtabPath) continue;
                newTabExtOptions += `<option value="${escapeAttr(ext.id)}" ${s.newTabExtId === ext.id ? "selected" : ""}>${escapeAttr(ext.name)}${ext.enabled ? "" : "（已停用）"}</option>`;
            }
        } catch {}
        const newTabExtRow = newTabExtOptions
            ? `<div class="b3-form__row"><label>${this.i18n.newTabExt || "新标签页扩展"}</label>
               <select id="sb-newtab-ext">
                   <option value="" ${!s.newTabExtId ? "selected" : ""}>${this.i18n.newTabExtNone || "（不使用，打开主页）"}</option>
                   ${newTabExtOptions}
               </select></div>
               <div class="b3-form__row sb-settings-desc">${escapeAttr(this.i18n.newTabExtDesc || "把带「新标签页」的扩展设为新页签的默认页；不选则打开主页。")}</div>`
            : "";
        // 异步加载笔记本列表
        const notebooks = await listNotebooks();
        const nbOptions = notebooks
            .map((n) => `<option value="${n.id}" ${n.id === s.excerptNotebook ? "selected" : ""}>${escapeAttr(n.name)}</option>`)
            .join("");
        // 已保存的笔记本 ID 失效（被删除/关闭）时显式标注，提示重新选择
        const staleOption = s.excerptNotebook && !notebooks.some((n) => n.id === s.excerptNotebook)
            ? `<option value="${escapeAttr(s.excerptNotebook)}" selected>(${escapeAttr(this.i18n.excerptNotebookStale || "已失效，请重新选择")})</option>`
            : "";
        return `
        <div class="b3-form sb-settings">
            <div class="b3-form__row">
                <label>${this.i18n.homepage}</label>
                <input id="sb-homepage" type="text" value="${escapeAttr(s.homepage)}" />
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.searchEngine}</label>
                <select id="sb-engine">
                    ${engineOptions}
                    <option value="custom" ${s.searchEngine === "custom" ? "selected" : ""}>${this.i18n.custom}</option>
                </select>
            </div>
            ${customUrlRow}
            <div class="b3-form__row">
                <label>${this.i18n.historyLimit}</label>
                <input id="sb-history-limit" type="number" min="0" max="50000" value="${s.historyLimit}" />
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.recordHistory}</label>
                <input id="sb-record-history" type="checkbox" ${s.recordHistory ? "checked" : ""} />
            </div>
            <div class="b3-form__row">
                <label title="${this.i18n.vmAutoConfirmDesc}">${this.i18n.vmAutoConfirm}</label>
                <input id="sb-vm-auto-confirm" type="checkbox" ${s.vmAutoConfirm !== false ? "checked" : ""} />
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.downloadTarget}</label>
                <select id="sb-download-target">
                    <option value="assets" ${s.downloadTarget === "assets" ? "selected" : ""}>${this.i18n.downloadAssets}</option>
                    <option value="storage" ${s.downloadTarget === "storage" ? "selected" : ""}>${this.i18n.downloadStorage}</option>
                </select>
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.userAgent}</label>
                <input id="sb-useragent" type="text" value="${escapeAttr(s.userAgent)}" placeholder="(default)" />
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.proxyMode || "代理"}</label>
                <select id="sb-proxy-mode">
                    <option value="siyuan" ${(s.proxyMode || "system") === "siyuan" ? "selected" : ""}>${this.i18n.proxyModeSiyuan || "跟随思源代理"}</option>
                    <option value="system" ${(s.proxyMode || "system") === "system" ? "selected" : ""}>${this.i18n.proxyModeSystem || "系统代理"}</option>
                    <option value="custom" ${(s.proxyMode || "system") === "custom" ? "selected" : ""}>${this.i18n.proxyModeCustom || "自定义代理"}</option>
                </select>
            </div>
            <div class="b3-form__row" style="font-size:12px;color:var(--b3-theme-on-surface-light);">
                ${this.i18n.proxyModeDesc || "浏览器页签使用的网络代理。「跟随思源代理」使用思源「设置 → 网络」中配置的代理（未配置时直连）；思源侧代理变更后需重新保存本设置生效。"}
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.proxyCustomUrl || "自定义代理地址"}</label>
                <input id="sb-proxy-url" type="text" value="${escapeAttr(s.proxyCustomUrl || "")}" placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7891" />
            </div>
            <div class="b3-form__row" style="font-size:12px;color:var(--b3-theme-on-surface-light);">
                ${this.i18n.proxyCustomUrlDesc || "仅「自定义代理」模式使用。支持 http://host:port、https://、socks5://，或分号分隔的分流规则（如 http=host:port;https=host:port）。留空回退系统代理。"}
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.enablePreload}</label>
                <input id="sb-preload" type="checkbox" ${s.enablePreload ? "checked" : ""} />
            </div>
            <div class="b3-form__row">
                <label>扩展面板 DevTools 调试</label>
                <input id="sb-popup-devtools" type="checkbox" ${s.popupDevtools ? "checked" : ""} />
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.excerptNotebook}</label>
                <select id="sb-excerpt-nb">
                    <option value="">(${this.i18n.excerptNotebook})</option>
                    ${nbOptions}
                    ${staleOption}
                </select>
            </div>
            ${newTabExtRow}
            <div class="b3-form__row">
                <label>${this.i18n.excerptParentPath || "摘录保存路径"}</label>
                <input id="sb-excerpt-path" type="text" value="${escapeAttr(s.excerptParentPath || "/")}" placeholder="/"/>
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.excerptTags || "摘录标签"}</label>
                <input id="sb-excerpt-tags" type="text" value="${escapeAttr(s.excerptTags || "")}" placeholder="web, clip"/>
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.excerptAssets || "摘录下载资源"}</label>
                <input id="sb-excerpt-assets" type="checkbox" ${s.excerptAssets !== false ? "checked" : ""} />
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.extManager || "Chrome 扩展"}</label>
                <button class="b3-button" id="sb-ext-manager">${this.i18n.extManageOpen || "管理扩展..."}</button>
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.interceptAllLinks}</label>
                <input id="sb-intercept-all" type="checkbox" ${s.interceptAllLinks ? "checked" : ""} />
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.excludedSites}</label>
                <textarea id="sb-excluded-sites" rows="4" style="width:100%;resize:vertical;font-family:monospace;" placeholder="weibo.com&#10;twitter.com&#10;# *.google.com">${escapeAttr(s.excludedSites)}</textarea>
            </div>
            <div class="b3-form__row" style="font-size:12px;color:var(--b3-theme-on-surface-light);">
                ${this.i18n.excludedSitesDesc}
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.adBlockEnabled || "广告过滤"}</label>
                <input id="sb-adblock" type="checkbox" ${s.adBlockEnabled !== false ? "checked" : ""} />
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.adBlockRules || "自定义广告规则"}</label>
                <textarea id="sb-adblock-rules" rows="5" style="width:100%;resize:vertical;font-family:monospace;" placeholder="tgb.cn###tcAd&#10;example.com##.ad-banner&#10;##iframe[src*=&quot;pos.baidu.com&quot;]&#10;example.com#@#.keep-me">${escapeAttr(s.adBlockRules || "")}</textarea>
            </div>
            <div class="b3-form__row" style="font-size:12px;color:var(--b3-theme-on-surface-light);">
                ${this.i18n.adBlockRulesDesc || "广告过滤为元素隐藏（CSS），不做网络拦截；修改后刷新页签生效。规则语法与 Adblock 一致：##选择器 全站生效，域名##选择器 仅该站点生效，域名#@#选择器 为例外。可直接粘贴 EasyList China 等公开列表的元素隐藏规则。"}
            </div>
            <div class="b3-form__row sb-settings-actions">
                <button class="b3-button" id="sb-save">${this.i18n.save}</button>
                <button class="b3-button b3-button--cancel" id="sb-cancel">${this.i18n.cancel}</button>
            </div>
        </div>
        `;
    }

    /** 由外部注入扩展宿主入口（BrowserTab 构造 SettingsDialog 时设置） */
    extensionOpener?: () => void;

    private bindEvents(original: BrowserSettings): void {
        const root = this.dialog!.element;
        const engineSel = root.querySelector("#sb-engine") as HTMLSelectElement;
        engineSel.addEventListener("change", () => {
            const wrap = root.querySelector(".sb-settings");
            const existing = wrap!.querySelector("#sb-custom-search-row");
            if (existing) existing.remove();
            if (engineSel.value === "custom") {
                const row = document.createElement("div");
                row.className = "b3-form__row";
                row.id = "sb-custom-search-row";
                row.innerHTML = `<label>${this.i18n.custom}</label><input id="sb-custom-search" type="text" value="${escapeAttr(original.customSearchUrl)}" placeholder="https://example.com/search?q={q}"/>`;
                engineSel.closest(".b3-form__row")!.after(row);
            }
        });

        root.querySelector("#sb-save")!.addEventListener("click", async () => {
            const patch: Partial<BrowserSettings> = {
                homepage: (root.querySelector("#sb-homepage") as HTMLInputElement).value.trim() || "about:blank",
                searchEngine: engineSel.value,
                customSearchUrl: (root.querySelector("#sb-custom-search") as HTMLInputElement)?.value.trim() || "",
                historyLimit: parseInt((root.querySelector("#sb-history-limit") as HTMLInputElement).value, 10) || 5000,
                recordHistory: (root.querySelector("#sb-record-history") as HTMLInputElement).checked,
                vmAutoConfirm: (root.querySelector("#sb-vm-auto-confirm") as HTMLInputElement)?.checked !== false,
                downloadTarget: (root.querySelector("#sb-download-target") as HTMLSelectElement).value as DownloadTarget,
                userAgent: (root.querySelector("#sb-useragent") as HTMLInputElement).value.trim(),
                proxyMode: ((root.querySelector("#sb-proxy-mode") as HTMLSelectElement)?.value || "system") as ProxyMode,
                proxyCustomUrl: (root.querySelector("#sb-proxy-url") as HTMLInputElement)?.value.trim() || "",
                enablePreload: (root.querySelector("#sb-preload") as HTMLInputElement).checked,
            popupDevtools: (root.querySelector("#sb-popup-devtools") as HTMLInputElement).checked,
                excerptNotebook: (root.querySelector("#sb-excerpt-nb") as HTMLSelectElement).value,
                excerptParentPath: (root.querySelector("#sb-excerpt-path") as HTMLInputElement).value.trim() || "/",
                excerptTags: (root.querySelector("#sb-excerpt-tags") as HTMLInputElement).value.trim(),
                excerptAssets: (root.querySelector("#sb-excerpt-assets") as HTMLInputElement).checked,
                interceptAllLinks: (root.querySelector("#sb-intercept-all") as HTMLInputElement).checked,
                excludedSites: (root.querySelector("#sb-excluded-sites") as HTMLTextAreaElement).value,
                adBlockEnabled: (root.querySelector("#sb-adblock") as HTMLInputElement).checked,
                adBlockRules: (root.querySelector("#sb-adblock-rules") as HTMLTextAreaElement).value,
                newTabExtId: (root.querySelector("#sb-newtab-ext") as HTMLSelectElement)?.value || "",
            };
            await this.store.save(patch);
            showMessage(this.i18n.save + " ✓", 2000, "info");
            this.dialog?.destroy();
        });

        root.querySelector("#sb-cancel")!.addEventListener("click", () => {
            this.dialog?.destroy();
        });

        const extBtn = root.querySelector("#sb-ext-manager") as HTMLButtonElement | null;
        extBtn?.addEventListener("click", () => {
            // 打开扩展管理前先关闭设置对话框，避免叠层
            this.dialog?.destroy();
            this.extensionOpener?.();
        });

    }
}

function escapeAttr(s: string): string {
    return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
