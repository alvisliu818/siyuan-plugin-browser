/** 创建带类名的元素 */
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    attrs?: Record<string, string>,
    text?: string
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            node.setAttribute(k, v);
        }
    }
    if (text != null) node.textContent = text;
    return node;
}

/** 清空元素子节点 */
export function clearChildren(node: HTMLElement): void {
    while (node.firstChild) node.removeChild(node.firstChild);
}

/** 简单 SVG 图标字符串生成（思源内置 iconfont 优先，否则用内联 SVG） */
export function svgIcon(path: string, viewBox = "0 0 24 24"): string {
    return `<svg viewBox="${viewBox}" width="16" height="16" fill="currentColor"><path d="${path}"/></svg>`;
}

/** 防抖 */
export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
    let timer: number | null = null;
    return ((...args: any[]) => {
        if (timer != null) window.clearTimeout(timer);
        timer = window.setTimeout(() => fn(...args), ms);
    }) as T;
}

/** 生成唯一 id */
export function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
    }
}
