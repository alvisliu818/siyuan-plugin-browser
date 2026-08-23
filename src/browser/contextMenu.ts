import { Menu } from "siyuan";
import type { IContextMenuParams, IWebviewTag } from "../types";
import { copyText } from "../utils/dom";

/**
 * 在 webview 上触发 context-menu 事件时弹出菜单。
 * 思源插件运行在 Electron 渲染进程中，`Menu` 由 siyuan 注入。
 */
export function showWebViewContextMenu(
    webview: IWebviewTag,
    params: IContextMenuParams,
    i18n: Record<string, string>,
    callbacks: {
        openInNewTab?: (url: string) => void;
        saveAs?: (url: string, suggestedName?: string) => void;
        copyImage?: (src: string) => void;
        excerpt?: () => void;
    }
): void {
    const menu = new Menu("sy-browser-ctx-menu");
    if (!menu) return;

    // 后退/前进/刷新
    menu.addItem({
        id: "back",
        iconHTML: iconBack(),
        label: i18n.back,
        click: () => webview.goBack(),
    });
    menu.addItem({
        id: "forward",
        iconHTML: iconForward(),
        label: i18n.forward,
        click: () => webview.goForward(),
    });
    menu.addItem({
        id: "reload",
        iconHTML: iconReload(),
        label: i18n.reload,
        click: () => webview.reload(),
    });
    menu.addSeparator();

    // 链接相关
    if (params.linkURL) {
        menu.addItem({
            id: "openInNewTab",
            iconHTML: iconTab(),
            label: i18n.openInNewTab,
            click: () => callbacks.openInNewTab?.(params.linkURL),
        });
        menu.addItem({
            id: "copyLink",
            iconHTML: iconCopy(),
            label: i18n.copyLink,
            click: () => copyText(params.linkURL),
        });
    }

    // 图片相关
    if (params.mediaType === "image" && params.srcURL) {
        menu.addItem({
            id: "copyImage",
            iconHTML: iconCopy(),
            label: i18n.copyImage,
            click: () => callbacks.copyImage?.(params.srcURL),
        });
        menu.addItem({
            id: "saveImage",
            iconHTML: iconSave(),
            label: i18n.saveAs,
            click: () => callbacks.saveAs?.(params.srcURL),
        });
    }

    // 另存为页面（仅在无链接/图片时）
    if (!params.linkURL && params.mediaType !== "image" && params.pageURL) {
        menu.addItem({
            id: "savePage",
            iconHTML: iconSave(),
            label: i18n.saveAs,
            click: () => callbacks.saveAs?.(params.pageURL),
        });
    }

    if (params.selectionText) {
        menu.addItem({
            id: "copySelection",
            iconHTML: iconCopy(),
            label: i18n.copyLink,
            click: () => copyText(params.selectionText),
        });
    }

    menu.addSeparator();

    // 摘录到思源
    menu.addItem({
        id: "excerpt",
        iconHTML: iconExcerpt(),
        label: i18n.excerpt || "摘录到思源",
        click: () => callbacks.excerpt?.(),
    });

    // 查看源代码
    menu.addItem({
        id: "viewSource",
        iconHTML: iconCode(),
        label: i18n.viewSource,
        click: async () => {
            const url = webview.getURL();
            if (url) {
                callbacks.openInNewTab?.("view-source:" + url);
            }
        },
    });

    // 检查元素
    menu.addItem({
        id: "inspect",
        iconHTML: iconCode(),
        label: i18n.inspect,
        click: () => {
            try {
                webview.openDevTools();
            } catch (e) {
                console.warn("openDevTools failed", e);
            }
        },
    });

    menu.open({
        x: params.x,
        y: params.y,
    });
}

// 内联 SVG 图标
const iconBack = () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`;
const iconForward = () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>`;
const iconReload = () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0012 4a8 8 0 108 8h-2a6 6 0 11-6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`;
const iconTab = () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 3H5c-1.11 0-2 .89-2 2v14a2 2 0 002 2h14c1.11 0 2-.89 2-2V5a2 2 0 00-2-2zm0 16H5V5h14v14z"/></svg>`;
const iconCopy = () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z"/></svg>`;
const iconSave = () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16a3 3 0 110-6 3 3 0 010 6zm3-10H5V5h10v4z"/></svg>`;
const iconCode = () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>`;
const iconExcerpt = () => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`;
