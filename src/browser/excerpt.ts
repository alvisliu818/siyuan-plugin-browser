import { fetchSyncPost, showMessage } from "siyuan";

/**
 * 网页摘录：提取网页正文 → 转为 Markdown → 在思源指定笔记本下创建新文档。
 */

/**
 * 注入到 webview 中提取网页正文。
 * 使用简化可靠的策略：article/main 容器 → innerText 提取纯文本，
 * 保留标题、链接、图片（Markdown 格式），避免复杂的 HTML→MD 转换出错。
 */
const EXTRACT_SCRIPT = `
(function() {
    var result = { title: document.title || "", url: location.href, content: "" };

    // 1. 选择正文容器
    var article = document.querySelector("article")
        || document.querySelector("main")
        || document.querySelector("[role=main]")
        || document.querySelector(".post-content, .article-content, .entry-content, .content, #content");

    if (!article) {
        // 兜底：取文本密度最大的元素
        var best = null, bestLen = 0;
        var candidates = document.querySelectorAll("div, section");
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (el.closest("nav, header, footer, aside, script, style, noscript")) continue;
            var text = el.innerText || "";
            if (text.length > bestLen) {
                bestLen = text.length;
                best = el;
            }
        }
        article = best || document.body;
    }

    if (!article) return JSON.stringify(result);

    // 2. 克隆节点并清理无关元素
    var clone = article.cloneNode(true);
    var removes = clone.querySelectorAll("script, style, noscript, iframe, nav, header, footer, aside, form, button, .ad, .ads, .advertisement, .share, .comment, .related, .recommend");
    removes.forEach(function(el) { el.remove(); });

    // 3. 提取 Markdown：遍历节点，按标签类型转换
    function htmlToMd(node) {
        var md = "";
        for (var i = 0; i < node.childNodes.length; i++) {
            var child = node.childNodes[i];
            if (child.nodeType === 3) {
                // 文本节点
                md += (child.textContent || "").replace(/\\s+/g, " ");
            } else if (child.nodeType === 1) {
                var tag = child.tagName.toLowerCase();
                var inner = htmlToMd(child);
                switch (tag) {
                    case "h1": md += "\\n\\n# " + inner.trim() + "\\n\\n"; break;
                    case "h2": md += "\\n\\n## " + inner.trim() + "\\n\\n"; break;
                    case "h3": md += "\\n\\n### " + inner.trim() + "\\n\\n"; break;
                    case "h4": md += "\\n\\n#### " + inner.trim() + "\\n\\n"; break;
                    case "h5": md += "\\n\\n##### " + inner.trim() + "\\n\\n"; break;
                    case "h6": md += "\\n\\n###### " + inner.trim() + "\\n\\n"; break;
                    case "p": md += "\\n\\n" + inner.trim() + "\\n\\n"; break;
                    case "br": md += "\\n"; break;
                    case "hr": md += "\\n\\n---\\n\\n"; break;
                    case "strong": case "b": md += "**" + inner + "**"; break;
                    case "em": case "i": md += "*" + inner + "*"; break;
                    case "code": md += "\`" + inner + "\`"; break;
                    case "pre": md += "\\n\\n\`\`\`\\n" + inner.trim() + "\\n\`\`\`\\n\\n"; break;
                    case "blockquote":
                        var lines = inner.trim().split("\\n");
                        for (var j = 0; j < lines.length; j++) { lines[j] = "> " + lines[j]; }
                        md += "\\n" + lines.join("\\n") + "\\n\\n";
                        break;
                    case "a":
                        var href = child.getAttribute("href") || "";
                        md += "[" + inner.trim() + "](" + href + ")";
                        break;
                    case "img":
                        var src = child.getAttribute("src") || child.getAttribute("data-src") || "";
                        var alt = child.getAttribute("alt") || "";
                        if (src) md += "![" + alt + "](" + src + ")";
                        break;
                    case "ul": case "ol":
                        var items = child.children;
                        for (var k = 0; k < items.length; k++) {
                            if (items[k].tagName.toLowerCase() === "li") {
                                var prefix = tag === "ol" ? (k + 1) + ". " : "- ";
                                md += "\\n" + prefix + htmlToMd(items[k]).trim();
                            }
                        }
                        md += "\\n\\n";
                        break;
                    case "li": md += inner; break;
                    case "div": case "section": case "span": md += inner; break;
                    default: md += inner;
                }
            }
        }
        return md;
    }

    result.content = htmlToMd(clone).replace(/\\n{3,}/g, "\\n\\n").trim();

    // 4. 兜底：如果转换后内容为空，直接用 innerText
    if (!result.content) {
        result.content = (article.innerText || "").trim();
    }

    return JSON.stringify(result);
})();
`;

export interface ExcerptResult {
    title: string;
    url: string;
    content: string;
}

/** 从 webview 提取网页正文 */
export async function extractPageContent(webview: any): Promise<ExcerptResult | null> {
    try {
        const json = await webview.executeJavaScript(EXTRACT_SCRIPT);
        console.log("[browser-plugin] extractPageContent raw result:", typeof json, (typeof json === "string" ? json.slice(0, 200) : json));
        const result = typeof json === "string" ? JSON.parse(json) : json;
        console.log("[browser-plugin] extractPageContent parsed:", {
            title: result.title,
            url: result.url,
            contentLen: (result.content || "").length,
            contentPreview: (result.content || "").slice(0, 100),
        });
        return result as ExcerptResult;
    } catch (e) {
        console.error("[browser-plugin] extractPageContent failed:", e);
        return null;
    }
}

/** 列出思源所有笔记本 */
export async function listNotebooks(): Promise<Array<{ id: string; name: string }>> {
    try {
        const resp: any = await fetchSyncPost("/api/notebook/lsNotebooks", {});
        const notebooks = resp?.data?.notebooks || [];
        return notebooks
            .filter((n: any) => !n.closed)
            .map((n: any) => ({ id: n.id, name: n.name }));
    } catch {
        return [];
    }
}

/**
 * 在思源指定笔记本下创建新文档，写入网页摘录内容。
 * 文档标题为网页标题，内容为正文 Markdown + 来源链接。
 */
export async function excerptToSiYuan(
    webview: any,
    notebookId: string,
    i18n: Record<string, string>
): Promise<void> {
    if (!notebookId) {
        showMessage(i18n.excerptFailed + ": " + (i18n.excerptNotebook || "notebook") + " ?", 3000, "error");
        return;
    }

    showMessage(i18n.excerpt + "...", 2000, "info");

    const extracted = await extractPageContent(webview);
    if (!extracted) {
        showMessage(i18n.excerptFailed + ": extract failed", 3000, "error");
        return;
    }
    if (!extracted.content) {
        showMessage(i18n.excerptFailed + ": content empty", 3000, "error");
        return;
    }

    // 组装 Markdown：来源信息放文章开头 + 正文
    const dateStr = new Date().toLocaleString();
    const md = [
        "> " + (i18n.excerpt || "Excerpt") + " - " + dateStr,
        "> URL: [" + extracted.url + "](" + extracted.url + ")",
        "",
        "---",
        "",
        extracted.content,
    ].join("\n");

    // 清理标题：移除思源文件名不允许的字符，避免"文件名重复"
    // 思源文件名不允许 / \ : * ? " < > |，且会因这些字符生成相同的非法文件名
    const cleanTitle = (extracted.title || "Untitled")
        .replace(/[\/\\:*?"<>|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100) || "Untitled";

    console.log("[browser-plugin] excerptToSiYuan creating doc:", {
        notebookId,
        cleanTitle,
        mdLen: md.length,
        mdPreview: md.slice(0, 200),
    });

    try {
        // 使用 createDocWithMd API 创建文档
        // 参数：notebook（笔记本ID）、path（文档路径，如 /标题，不含笔记本ID）、markdown（内容）
        // 注意：path 是 hpath（人类可读路径），不是笔记本ID开头的路径
        const baseTitle = cleanTitle;
        let attempt = 0;
        let resp: any;
        while (true) {
            const tryTitle = attempt === 0 ? baseTitle : `${baseTitle} (${attempt})`;
            const fullPath = "/" + tryTitle;
            resp = await fetchSyncPost("/api/filetree/createDocWithMd", {
                notebook: notebookId,
                path: fullPath,
                markdown: md,
            });
            console.log(`[browser-plugin] createDocWithMd attempt ${attempt}, path: ${fullPath}, resp:`, resp);
            if (resp?.code === 0) {
                showMessage(i18n.excerptComplete + ": " + tryTitle, 3000, "info");
                return;
            }
            // 文件名重复 → 换标题重试
            if (resp?.msg === "文件名重复" || resp?.msg?.includes("重复")) {
                attempt++;
                if (attempt > 50) break;
                continue;
            }
            break; // 其他错误不再重试
        }
        console.error("[browser-plugin] createDoc failed:", resp);
        showMessage(i18n.excerptFailed + ": " + (resp?.msg || "unknown"), 4000, "error");
    } catch (e: any) {
        console.error("[browser-plugin] excerptToSiYuan failed:", e);
        showMessage(i18n.excerptFailed + ": " + (e?.message || e), 4000, "error");
    }
}
