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
        iconHTML: "",
        label: i18n.back,
        click: () => webview.goBack(),
    });
    menu.addItem({
        id: "forward",
        iconHTML: "",
        label: i18n.forward,
        click: () => webview.goForward(),
    });
    menu.addItem({
        id: "reload",
        iconHTML: "",
        label: i18n.reload,
        click: () => webview.reload(),
    });
    menu.addSeparator();

    // 链接相关
    if (params.linkURL) {
        menu.addItem({
            id: "openInNewTab",
            iconHTML: "",
            label: i18n.openInNewTab,
            click: () => callbacks.openInNewTab?.(params.linkURL),
        });
        menu.addItem({
            id: "copyLink",
            iconHTML: "",
            label: i18n.copyLink,
            click: () => copyText(params.linkURL),
        });
    }

    // 图片相关
    if (params.mediaType === "image" && params.srcURL) {
        menu.addItem({
            id: "copyImage",
            iconHTML: "",
            label: i18n.copyImage,
            click: () => callbacks.copyImage?.(params.srcURL),
        });
        menu.addItem({
            id: "saveImage",
            iconHTML: "",
            label: i18n.saveAs,
            click: () => callbacks.saveAs?.(params.srcURL),
        });
    }

    // 另存为页面（仅在无链接/图片时）
    if (!params.linkURL && params.mediaType !== "image" && params.pageURL) {
        menu.addItem({
            id: "savePage",
            iconHTML: "",
            label: i18n.saveAs,
            click: () => callbacks.saveAs?.(params.pageURL),
        });
    }

    if (params.selectionText) {
        menu.addItem({
            id: "copySelection",
            iconHTML: "",
            label: i18n.copyLink,
            click: () => copyText(params.selectionText),
        });
    }

    menu.addSeparator();

    // 摘录到思源
    menu.addItem({
        id: "excerpt",
        iconHTML: "",
        label: i18n.excerpt || "摘录到思源",
        click: () => callbacks.excerpt?.(),
    });

    // 查看源代码
    menu.addItem({
        id: "viewSource",
        iconHTML: "",
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
        iconHTML: "",
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
