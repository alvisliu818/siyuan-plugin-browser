import { Dialog, showMessage } from "siyuan";
import type { SettingsStore } from "../storage/settingsStore";
import type { BrowserSettings, DownloadTarget } from "../types";
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
        // 异步加载笔记本列表
        const notebooks = await listNotebooks();
        const nbOptions = notebooks
            .map((n) => `<option value="${n.id}" ${n.id === s.excerptNotebook ? "selected" : ""}>${escapeAttr(n.name)}</option>`)
            .join("");
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
                <label>${this.i18n.enablePreload}</label>
                <input id="sb-preload" type="checkbox" ${s.enablePreload ? "checked" : ""} />
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.excerptNotebook}</label>
                <select id="sb-excerpt-nb">
                    <option value="">(${this.i18n.excerptNotebook})</option>
                    ${nbOptions}
                </select>
            </div>
            <div class="b3-form__row">
                <label>${this.i18n.interceptAllLinks}</label>
                <input id="sb-intercept-all" type="checkbox" ${s.interceptAllLinks ? "checked" : ""} />
            </div>
            <div class="b3-form__row sb-settings-actions">
                <button class="b3-button" id="sb-save">${this.i18n.save}</button>
                <button class="b3-button b3-button--cancel" id="sb-cancel">${this.i18n.cancel}</button>
            </div>
        </div>
        `;
    }

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
                downloadTarget: (root.querySelector("#sb-download-target") as HTMLSelectElement).value as DownloadTarget,
                userAgent: (root.querySelector("#sb-useragent") as HTMLInputElement).value.trim(),
                enablePreload: (root.querySelector("#sb-preload") as HTMLInputElement).checked,
                excerptNotebook: (root.querySelector("#sb-excerpt-nb") as HTMLSelectElement).value,
                interceptAllLinks: (root.querySelector("#sb-intercept-all") as HTMLInputElement).checked,
            };
            await this.store.save(patch);
            showMessage(this.i18n.save + " ✓", 2000, "info");
            this.dialog?.destroy();
        });

        root.querySelector("#sb-cancel")!.addEventListener("click", () => {
            this.dialog?.destroy();
        });
    }
}

function escapeAttr(s: string): string {
    return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
