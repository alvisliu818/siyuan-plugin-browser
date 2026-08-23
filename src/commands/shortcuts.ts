import type { Plugin } from "siyuan";
import { TAB_TYPE } from "../constants";

/** 注册快捷键命令 */
export function registerShortcuts(plugin: Plugin, i18n: Record<string, string>): void {
    // 获取当前活动的浏览器页签实例。
    // 通过 plugin.tabInstances（在 index.ts 中维护）和思源活动页签双重判断。
    const getActiveBrowserTab = (): any => {
        const p = plugin as any;
        const instances: Map<string, any> = p.tabInstances ?? new Map();
        if (instances.size === 0) return null;
        // 优先返回当前可见（ isConnected ）的页签
        for (const [, tab] of instances) {
            if (tab?.element?.isConnected) {
                // 检查是否在视口可见（最近的 .sy-browser-tab 父元素有 offsetParent）
                if (tab.element.offsetParent !== null) return tab;
            }
        }
        // 兜底：返回第一个
        for (const [, tab] of instances) return tab;
        return null;
    };

    const newTab = () => {
        const homepage = (plugin as any).settingsStore?.get()?.homepage || "about:blank";
        (plugin as any).openUrl?.(homepage);
    };

    const commands = [
        { langKey: "newTab", hotkey: "⌘T", fn: newTab },
        {
            langKey: "closeTab",
            hotkey: "⌘W",
            fn: () => {
                // 关闭当前思源页签
                try {
                    const activeTab = (window as any).siyuan?.layout?.centerLayout?.children?.[0]?.children?.find(
                        (t: any) => t.headElement?.classList?.contains("item--focus")
                    );
                    activeTab?.parent?.removeTab?.(activeTab.id);
                } catch {}
            },
        },
        {
            langKey: "back",
            hotkey: "⌘[",
            fn: () => getActiveBrowserTab()?.goBack?.(),
        },
        {
            langKey: "forward",
            hotkey: "⌘]",
            fn: () => getActiveBrowserTab()?.goForward?.(),
        },
        {
            langKey: "reload",
            hotkey: "⌘R",
            fn: () => getActiveBrowserTab()?.reload?.(),
        },
        {
            langKey: "forceReload",
            hotkey: "⇧⌘R",
            fn: () => getActiveBrowserTab()?.reload?.(true),
        },
        {
            langKey: "findInPage",
            hotkey: "⌘F",
            fn: () => {
                const tab = getActiveBrowserTab();
                if (tab && tab.toolbar) {
                    tab.toolbar.element.querySelector('[data-act="find"]')?.dispatchEvent(new Event("click"));
                }
            },
        },
        {
            langKey: "addressBar",
            hotkey: "⌘L",
            fn: () => getActiveBrowserTab()?.focusUrl?.(),
        },
        {
            langKey: "bookmarks",
            hotkey: "⌥⌘B",
            fn: () => document.dispatchEvent(new CustomEvent("sy-browser-open-dock", { detail: { type: "bookmarks" } })),
        },
        {
            langKey: "history",
            hotkey: "⌥⌘Y",
            fn: () => document.dispatchEvent(new CustomEvent("sy-browser-open-dock", { detail: { type: "history" } })),
        },
    ];

    for (const c of commands) {
        try {
            plugin.addCommand({
                langKey: c.langKey,
                langText: i18n[c.langKey] || c.langKey,
                hotkey: c.hotkey,
                callback: () => c.fn(),
            });
        } catch (e) {
            console.warn("Failed to register command", c.langKey, e);
        }
    }
}
