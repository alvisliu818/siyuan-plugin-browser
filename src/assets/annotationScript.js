/**
 * 网页标注页内脚本：通过 webview.executeJavaScript 注入到浏览器页签的页面上下文。
 * 以原始字符串内嵌（webpack asset/source），在页面主世界执行。
 *
 * 职责：
 * 1. 选区悬浮小气泡：选中文字后弹出「标注」按钮，点击写入 window.__syAnnCreate
 *    事件，由宿主（WebviewController 300ms 轮询）拾取并落到思源标注文档；
 * 2. 标注高亮：按锚点数据（quote + 前后文）在页面里查找并包裹 <mark class="sy-ann-hl">，
 *    每次打开同一网页由宿主经 __syAnnInit 传入全部标注并恢复高亮位置；
 * 3. 悬浮弹窗：鼠标悬浮高亮时显示绑定的思源块内容（选中文字引述 + 批注段落）。
 */
(function () {
    if (window.__syAnnInjected) return;
    window.__syAnnInjected = true;

    var CSS = [
        ".sy-ann-hl{position:relative;background:rgba(255,213,0,.4);border-radius:2px;cursor:pointer;box-decoration-break:clone;-webkit-box-decoration-break:clone;}",
        ".sy-ann-hl:hover{background:rgba(255,170,0,.6);}",
        ".sy-ann-bubble{position:fixed;z-index:2147483645;display:flex;align-items:center;gap:2px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.22);padding:3px;font-family:sans-serif;}",
        ".sy-ann-bubble button{border:none;background:transparent;cursor:pointer;font-size:12px;padding:3px 10px;border-radius:4px;line-height:16px;}",
        ".sy-ann-bubble .sy-ann-create{background:#1a73e8;color:#fff;font-weight:600;}",
        ".sy-ann-pop{position:fixed;z-index:2147483645;max-width:340px;max-height:260px;overflow:auto;background:#fff;color:#222;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.25);padding:10px 12px;font-size:13px;line-height:1.5;font-family:sans-serif;word-break:break-word;}",
        ".sy-ann-pop-quote{font-size:12px;color:#666;border-left:3px solid #f5c542;padding-left:8px;margin-bottom:6px;white-space:pre-wrap;}",
        ".sy-ann-pop-note{white-space:pre-wrap;}",
        ".sy-ann-pop-empty{color:#999;font-style:italic;}",
        ".sy-ann-pop-meta{margin-top:6px;font-size:11px;color:#aaa;}",
        ".sy-ann-inline{position:absolute;left:0;top:100%;display:block;font-size:11px;color:#8a6d1a;background:none;border-radius:0;padding:0;margin:1px 0 0;cursor:pointer;line-height:1.2;white-space:nowrap;z-index:5;}",
        ".sy-ann-inline:hover{opacity:.15;}",
        ".sy-ann-c-yellow{background:rgba(255,213,0,.4)!important;}",
        ".sy-ann-c-green{background:rgba(120,220,120,.45)!important;}",
        ".sy-ann-c-blue{background:rgba(120,180,255,.45)!important;}",
        ".sy-ann-c-pink{background:rgba(255,150,200,.45)!important;}",
        ".sy-ann-c-purple{background:rgba(190,140,255,.45)!important;}",
        ".sy-ann-swatches{display:flex;gap:4px;align-items:center;margin:6px 0;}",
        ".sy-ann-sw{width:16px;height:16px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;}",
        ".sy-ann-sw.on{border-color:#333;}",
        ".sy-ann-sw-yellow{background:rgba(255,213,0,.9);}",
        ".sy-ann-sw-green{background:rgba(120,220,120,.9);}",
        ".sy-ann-sw-blue{background:rgba(120,180,255,.9);}",
        ".sy-ann-sw-pink{background:rgba(255,150,200,.9);}",
        ".sy-ann-sw-purple{background:rgba(190,140,255,.9);}",
        ".sy-ann-tags{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0;}",
        ".sy-ann-tag{font-size:11px;background:#eef;border-radius:3px;padding:1px 6px;cursor:pointer;color:#335;}",
        ".sy-ann-taginput{font-size:12px;border:1px solid #ddd;border-radius:4px;padding:2px 6px;width:110px;}",
        ".sy-ann-pop-actions{margin-top:8px;display:flex;gap:6px;justify-content:flex-end;}",
        ".sy-ann-pop-actions button{border:1px solid #ddd;background:#f7f7f7;border-radius:4px;font-size:12px;padding:2px 8px;cursor:pointer;}",
        "@keyframes syAnnFlash{0%{background:rgba(255,160,0,.9);}100%{background:rgba(255,213,0,.4);}}",
        ".sy-ann-flash{animation:syAnnFlash 1.8s ease-out;}"
    ].join("");

    function ensureStyle() {
        if (document.getElementById("sy-ann-style")) return;
        var s = document.createElement("style");
        s.id = "sy-ann-style";
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    var list = window.__syAnnList = [];

    function esc(s) {
        return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function norm(s) {
        return String(s || "").replace(/\s+/g, " ");
    }

    function escRe(s) {
        return s.replace(/[.*+?^$(){}[\]\\]/g, "\\$&");
    }

    // ===== 文本收集与高亮包裹 =====

    function collectTextNodes() {
        var nodes = [], text = "";
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
                var p = n.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                if (p.closest("script,style,noscript,textarea,xmp")) return NodeFilter.FILTER_REJECT;
                if (p.closest(".sy-ann-hl,.sy-ann-bubble,.sy-ann-inline,.sy-ann-pop")) return NodeFilter.FILTER_REJECT;
                if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
            text += walker.currentNode.nodeValue;
        }
        return { nodes: nodes, text: text };
    }

    /** 在页面文本里定位 quote（容忍空白差异），prefix/suffix 优先命中 */
    function locate(c, quote, prefix, suffix) {
        var words = quote.split(/\s+/).map(function (w) { return escRe(w); }).filter(Boolean);
        if (!words.length) return null;
        var re = new RegExp(words.join("\\s+"), "g");
        var best = null, m;
        while ((m = re.exec(c.text)) !== null) {
            if (re.lastIndex === m.index) re.lastIndex++;
            var pre = norm(c.text.slice(Math.max(0, m.index - 30), m.index));
            var suf = norm(c.text.slice(m.index + m[0].length, m.index + m[0].length + 30));
            var score = 0;
            if (prefix && pre.indexOf(norm(prefix).slice(-20)) >= 0) score += 2;
            if (suffix && suf.indexOf(norm(suffix).slice(0, 20)) >= 0) score += 2;
            if (!best || score > best.score) best = { index: m.index, len: m[0].length, score: score };
            if (score >= 4) break;
        }
        return best;
    }

    function wrapOne(ann) {
        if (!ann || !ann.quote || !String(ann.quote).trim()) return 0;
        // 已渲染过的标注跳过：懒加载重试(__syAnnRender)会对全部条目重新定位，
        // 原位置文本已被包裹并从收集范围排除，重新 locate 会退化命中到错误的
        // 出现位置（同一标注在错误位置重复高亮）
        var renderedId = String(ann.id || "").replace(/[^A-Za-z0-9_-]/g, "");
        if (renderedId && document.querySelector('mark.sy-ann-hl[data-ann-id="' + renderedId + '"]')) return 0;
        var c = collectTextNodes();
        if (!c.text) return 0;
        var hit = locate(c, ann.quote, ann.prefix || "", ann.suffix || "");
        if (!hit) return 0;
        var start = hit.index, end = hit.index + hit.len;
        // 命中区间映射回文本节点（已包裹的节点被 collect 过滤，天然不重复包裹）
        var pos = 0, spans = [];
        for (var i = 0; i < c.nodes.length; i++) {
            var node = c.nodes[i];
            var nlen = node.nodeValue.length;
            var s = Math.max(start, pos);
            var e = Math.min(end, pos + nlen);
            if (e > s) spans.push({ node: node, s: s - pos, e: e - pos });
            pos += nlen;
            if (pos >= end) break;
        }
        var wrapped = 0;
        // 从后往前包裹，前面节点的索引不受 splitText 影响
        for (var j = spans.length - 1; j >= 0; j--) {
            var sp = spans[j];
            var n = sp.node;
            try {
                if (sp.e < n.nodeValue.length) n.splitText(sp.e);
                var target = sp.s > 0 ? n.splitText(sp.s) : n;
                var mark = document.createElement("mark");
                mark.className = "sy-ann-hl sy-ann-c-" + (ann.color || "yellow");
                mark.setAttribute("data-ann-id", String(ann.id || ""));
                // splitText 后 target 的 nodeValue 恰好是 [s,e) 区间文本，必须带回 mark 内
                mark.textContent = target.nodeValue;
                target.parentNode.replaceChild(mark, target);
                wrapped++;
            } catch (e) { /* 节点已失效等情况忽略 */ }
        }
        // 内联小字：高亮后附截断的批注摘要，页面内不点开即可快速浏览
        if (wrapped && inlineVisible && ann.note && String(ann.note).trim()) {
            try {
                var marks = document.querySelectorAll('mark.sy-ann-hl[data-ann-id="' + renderedId + '"]');
                var lastMark = marks[marks.length - 1];
                if (lastMark && !lastMark.querySelector(".sy-ann-inline")) {
                    var inline = document.createElement("span");
                    inline.className = "sy-ann-inline";
                    inline.setAttribute("data-ann-id", String(ann.id || ""));
                    var nt = String(ann.note).replace(/\s+/g, " ").trim();
                    inline.textContent = nt.length > 40 ? nt.slice(0, 40) + "…" : nt;
                    inline.title = nt;
                    lastMark.appendChild(inline);
                }
            } catch (e) { /* 忽略 */ }
        }
        return wrapped;
    }

    // ===== 悬浮弹窗（鼠标悬浮高亮 → 显示绑定的思源块内容）=====

    // Popover API：顶层渲染，免疫页面自身的 transform/层叠/CSS 覆盖（Chromium 114+）
    function layerShow(el, display) {
        try {
            if ("popover" in el && !el.matches(":popover-open")) el.showPopover();
        } catch (e) {}
        el.style.display = display;
    }

    function layerHide(el) {
        try {
            if ("popover" in el && el.matches(":popover-open")) el.hidePopover();
        } catch (e) {}
        el.style.display = "none";
    }

    // 定位坐标走 adoptedStyleSheets（CSSOM）：meta CSP 禁 style 属性的站点，
    // style.left/top 会被静默忽略（元素退回文档流位置），CSSOM 不受 CSP 限制。
    // 内联 left/top 仍同步写入，作不支持 adoptedStyleSheets 引擎的兜底。
    var posSheet = null;
    var posState = {};
    function setPos(id, x, y) {
        posState[id] = { x: x, y: y };
        var el = document.getElementById(id);
        if (el) { el.style.left = x + "px"; el.style.top = y + "px"; }
        try {
            if (posSheet === null && typeof CSSStyleSheet !== "undefined" && CSSStyleSheet.prototype && "replaceSync" in CSSStyleSheet.prototype) {
                posSheet = new CSSStyleSheet();
                var arr = (document.adoptedStyleSheets || []).slice();
                arr.push(posSheet);
                document.adoptedStyleSheets = arr;
            }
            if (posSheet) {
                var rules = [];
                for (var k in posState) rules.push("#" + k + "{left:" + posState[k].x + "px;top:" + posState[k].y + "px;}");
                posSheet.replaceSync(rules.join(""));
            }
        } catch (e) {}
    }

    function pointInRect(x, y, r) {
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    /**
     * 命中标注高亮：先按 elementFromPoint 精确命中；跨行 inline mark 的联合矩形
     * 存在未绘制空隙（首行末/次行首），elementFromPoint 会落到父级元素 —— 退化为
     * 按 mark 矩形范围匹配，保证跨行标注的任意位置点击都能命中。
     */
    function markAtPoint(x, y) {
        var el = document.elementFromPoint(x, y);
        var m = el && el.closest ? el.closest(".sy-ann-hl,.sy-ann-inline") : null;
        if (m) return m;
        var marks = document.querySelectorAll("mark.sy-ann-hl,.sy-ann-inline");
        for (var i = 0; i < marks.length; i++) {
            if (pointInRect(x, y, marks[i].getBoundingClientRect())) return marks[i];
        }
        return null;
    }

    // ===== 悬浮/点击轻量小窗（页内渲染、数据已在页内免内核往返，快速浏览）=====
    var popPinned = false;
    var popHover = false;

    function findAnn(id) {
        for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
        return null;
    }

    var COLORS = ["yellow", "green", "blue", "pink", "purple"];
    var bubbleColor = "yellow";
    var inlineVisible = true;
    var popHideTimer = null;
    function cancelPopHide() { if (popHideTimer) { clearTimeout(popHideTimer); popHideTimer = null; } }
    // 移开宽限：鼠标离开高亮后延迟收起，留出移入小窗点按钮的时间
    function schedulePopHide() {
        cancelPopHide();
        popHideTimer = setTimeout(function () {
            popHideTimer = null;
            if (!popPinned && !popHover) { var p = document.getElementById("sy-ann-pop"); if (p) layerHide(p); }
        }, 300);
    }

    function ensurePop() {
        var p = document.getElementById("sy-ann-pop");
        if (p) return p;
        p = document.createElement("div");
        p.id = "sy-ann-pop";
        p.className = "sy-ann-pop";
        p.style.display = "none";
        try { p.setAttribute("popover", "manual"); } catch (e) {}
        p.addEventListener("click", function (e) {
            var id = p.getAttribute("data-ann-id");
            var sw = e.target.closest ? e.target.closest("[data-ann-color]") : null;
            if (sw) { e.stopPropagation(); setMeta(id, { color: sw.getAttribute("data-ann-color") }); return; }
            var tg = e.target.closest ? e.target.closest("[data-ann-tag]") : null;
            if (tg) { e.stopPropagation(); removeTag(id, tg.getAttribute("data-ann-tag")); return; }
            var b = e.target.closest ? e.target.closest("[data-ann-act]") : null;
            if (!b) return;
            e.stopPropagation();
            var act = b.getAttribute("data-ann-act");
            if (act === "edit") { hidePop(true); window.__syAnnOpen = { id: id, x: 0, y: 0, edit: true }; }
            else if (act === "close") { hidePop(true); }
        });
        p.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && e.target.classList && e.target.classList.contains("sy-ann-taginput")) {
                e.preventDefault(); e.stopPropagation();
                var v = String(e.target.value || "").trim();
                if (v) { addTag(p.getAttribute("data-ann-id"), v); e.target.value = ""; }
            }
        });
        p.addEventListener("mouseenter", function () { popHover = true; cancelPopHide(); });
        p.addEventListener("mouseleave", function () { popHover = false; if (!popPinned) schedulePopHide(); });
        document.body.appendChild(p);
        return p;
    }

    function applyColor(id, color) {
        var safeId = String(id || "").replace(/[^A-Za-z0-9_-]/g, "");
        var ms = document.querySelectorAll('mark.sy-ann-hl[data-ann-id="' + safeId + '"]');
        for (var i = 0; i < ms.length; i++) ms[i].className = "sy-ann-hl sy-ann-c-" + (color || "yellow");
    }
    function setMeta(id, patch) {
        var ann = findAnn(id);
        if (!ann) return;
        if (patch.color) ann.color = patch.color;
        if (patch.tags) ann.tags = patch.tags;
        window.__syAnnMeta = { id: id, color: ann.color || "yellow", tags: ann.tags || [] };
        applyColor(id, ann.color);
        var p = document.getElementById("sy-ann-pop");
        if (p && p.style.display !== "none" && p.getAttribute("data-ann-id") === String(id)) renderPopBody(p, ann);
    }
    function addTag(id, t) { var a = findAnn(id); if (!a) return; var tags = (a.tags || []).slice(); if (tags.indexOf(t) < 0) tags.push(t); setMeta(id, { tags: tags }); }
    function removeTag(id, t) { var a = findAnn(id); if (!a) return; setMeta(id, { tags: (a.tags || []).filter(function (x) { return x !== t; }) }); }

    function renderPopBody(p, ann) {
        var note = String(ann.note || "").trim();
        var html = "";
        if (ann.quote) html += '<div class="sy-ann-pop-quote">' + esc(ann.quote) + "</div>";
        html += note ? '<div class="sy-ann-pop-note">' + esc(note) + "</div>" : '<div class="sy-ann-pop-empty">（无批注）</div>';
        html += '<div class="sy-ann-swatches">';
        for (var i = 0; i < COLORS.length; i++) {
            var c = COLORS[i];
            html += '<button class="sy-ann-sw sy-ann-sw-' + c + ((ann.color || "yellow") === c ? " on" : "") + '" data-ann-color="' + c + '" title="' + c + '"></button>';
        }
        html += "</div>";
        var tags = ann.tags || [];
        html += '<div class="sy-ann-tags">';
        for (var j = 0; j < tags.length; j++) html += '<span class="sy-ann-tag" data-ann-tag="' + esc(tags[j]) + '" title="点击移除">' + esc(tags[j]) + " ×</span>";
        html += '<input class="sy-ann-taginput" placeholder="+标签(回车)" />';
        html += "</div>";
        html += '<div class="sy-ann-pop-actions"><button data-ann-act="edit">在思源编辑</button><button data-ann-act="close">关闭</button></div>';
        p.innerHTML = html;
    }

    function showPop(ann, x, y, pinned) {
        var p = ensurePop();
        cancelPopHide();
        popPinned = !!pinned;
        p.setAttribute("data-ann-id", String(ann.id || ""));
        renderPopBody(p, ann);
        var px = Math.min(Math.max(x + 12, 8), Math.max(8, window.innerWidth - 350));
        var py = Math.min(Math.max(y + 12, 8), Math.max(8, window.innerHeight - 240));
        p.style.left = px + "px"; p.style.top = py + "px";
        setPos("sy-ann-pop", Math.round(px), Math.round(py));
        layerShow(p, "block");
    }

    function hidePop(force) {
        cancelPopHide();
        if (popPinned && !force) return;
        popPinned = false;
        var p = document.getElementById("sy-ann-pop");
        if (p) layerHide(p);
    }

    // 悬浮高亮/内联小字 → 轻量小窗
    document.addEventListener("mouseover", function (e) {
        var m = e.target.closest ? e.target.closest(".sy-ann-hl,.sy-ann-inline") : null;
        if (!m || popPinned) return;
        var id = m.getAttribute("data-ann-id");
        var cur = document.getElementById("sy-ann-pop");
        if (cur && cur.style.display !== "none" && cur.getAttribute("data-ann-id") === String(id)) { cancelPopHide(); return; }
        var ann = findAnn(id);
        if (ann) showPop(ann, e.clientX, e.clientY, false);
    }, true);
    document.addEventListener("mouseout", function (e) {
        var m = e.target.closest ? e.target.closest(".sy-ann-hl,.sy-ann-inline") : null;
        if (!m || popPinned || popHover) return;
        var to = e.relatedTarget;
        if (to && to.closest && to.closest("#sy-ann-pop")) return;
        schedulePopHide();
    }, true);

    // 点击高亮/内联小字 → 固定快速小窗（不开思源窗口）;「在思源编辑」按钮才开。点别处收起
    document.addEventListener("click", function (e) {
        var inPop = e.target.closest ? e.target.closest("#sy-ann-pop") : null;
        if (inPop) return;
        var m = markAtPoint(e.clientX, e.clientY);
        if (!m) { hidePop(true); return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        var ann = findAnn(m.getAttribute("data-ann-id"));
        if (ann) showPop(ann, e.clientX, e.clientY, true);
    }, true);

    // ===== 选区悬浮小气泡 =====

    function hideBubble() {
        var b = document.getElementById("sy-ann-bubble");
        if (b) layerHide(b);
    }

    function ensureBubble() {
        var b = document.getElementById("sy-ann-bubble");
        if (b) return b;
        b = document.createElement("div");
        b.id = "sy-ann-bubble";
        b.className = "sy-ann-bubble";
        b.style.display = "none";
        try { b.setAttribute("popover", "manual"); } catch (e) {}
        b.innerHTML = '<span class="sy-ann-swatches">' + COLORS.map(function (c) { return '<button class="sy-ann-sw sy-ann-sw-' + c + (c === "yellow" ? " on" : "") + '" data-ann-color="' + c + '" title="' + c + '"></button>'; }).join("") + "</span>" +
            '<button class="sy-ann-create" data-ann-act="create">标注</button>' +
            '<button data-ann-act="close" title="关闭">×</button>';
        b.addEventListener("click", function (e) {
            var sw = e.target.closest ? e.target.closest("[data-ann-color]") : null;
            if (!sw) return;
            e.stopPropagation();
            bubbleColor = sw.getAttribute("data-ann-color");
            var sws = b.querySelectorAll(".sy-ann-sw");
            for (var i = 0; i < sws.length; i++) sws[i].classList.toggle("on", sws[i] === sw);
        });
        // mousedown 阶段处理（mouseup 清选区之前），阻止选区被清除
        b.addEventListener("mousedown", function (e) {
            e.preventDefault();
            e.stopPropagation();
            var t = e.target.closest ? e.target.closest("[data-ann-act]") : null;
            if (!t) return;
            var act = t.getAttribute("data-ann-act");
            if (act === "create" && b.__ann) {
                b.__ann.color = bubbleColor;
                window.__syAnnCreate = b.__ann;
                b.__ann = null;
                try { window.getSelection().removeAllRanges(); } catch (err) {}
            }
            hideBubble();
        }, true);
        document.body.appendChild(b);
        return b;
    }

    document.addEventListener("mouseup", function (e) {
        // 气泡自身的点击不参与选区判定
        if (e.target && e.target.closest && e.target.closest(".sy-ann-bubble")) return;
        setTimeout(function () {
            var sel = window.getSelection();
            if (!sel || !sel.rangeCount || sel.isCollapsed) { hideBubble(); return; }
            var quote = norm(sel.toString()).trim();
            if (!quote || quote.length > 3000) { hideBubble(); return; }
            var range = sel.getRangeAt(0);
            var pre = "", suf = "";
            try {
                if (range.startContainer.nodeType === 3) {
                    pre = norm(range.startContainer.nodeValue.slice(0, range.startOffset)).trim().slice(-30);
                }
                if (range.endContainer.nodeType === 3) {
                    suf = norm(range.endContainer.nodeValue.slice(range.endOffset)).trim().slice(0, 30);
                }
            } catch (err) {}
            var r = range.getBoundingClientRect();
            if (!r || (!r.width && !r.height)) { hideBubble(); return; }
            var b = ensureBubble();
            b.__ann = { quote: quote, prefix: pre, suffix: suf };
            var bx = Math.min(Math.max(r.left + r.width / 2 - 34, 8), window.innerWidth - 90);
            var by = r.top > 40 ? r.top - 34 : r.bottom + 6;
            b.style.left = bx + "px";
            b.style.top = by + "px";
            layerShow(b, "flex");
            setPos("sy-ann-bubble", Math.round(bx), Math.round(by));
        }, 10);
    }, true);

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { hideBubble(); }
    });
    document.addEventListener("click", function (e) {
        if (e.target && e.target.closest && !e.target.closest(".sy-ann-bubble")) hideBubble();
    }, true);

    // ===== 宿主入口 =====

    window.__syAnnInit = function (items, showInline) {
        ensureStyle();
        if (showInline !== undefined) inlineVisible = !!showInline;
        list.length = 0;
        for (var i = 0; i < (items || []).length; i++) list.push(items[i]);
        window.__syAnnRender();
    };

    // 设置开关：显示/隐藏页内批注小字
    window.__syAnnSetInlineVisible = function (v) {
        inlineVisible = !!v;
        var inls = document.querySelectorAll(".sy-ann-inline");
        for (var i = 0; i < inls.length; i++) inls[i].style.display = inlineVisible ? "" : "none";
    };

    window.__syAnnRender = function () {
        for (var i = 0; i < list.length; i++) wrapOne(list[i]);
    };

    window.__syAnnApply = function (items) {
        ensureStyle();
        for (var i = 0; i < (items || []).length; i++) {
            list.push(items[i]);
            wrapOne(items[i]);
        }
    };

    // 编辑后刷新批注文本（内联小字 + 缓存），不重新包裹高亮
    window.__syAnnSetNotes = function (items) {
        for (var i = 0; i < (items || []).length; i++) {
            var it = items[i];
            for (var j = 0; j < list.length; j++) {
                if (String(list[j].id) === String(it.id)) {
                    list[j].note = it.note;
                    if (it.color) list[j].color = it.color;
                    if (it.tags) list[j].tags = it.tags;
                }
            }
            if (it.color) applyColor(it.id, it.color);
            var safeId = String(it.id || "").replace(/[^A-Za-z0-9_-]/g, "");
            var inl = document.querySelector('.sy-ann-inline[data-ann-id="' + safeId + '"]');
            if (inl) {
                var nt = String(it.note || "").replace(/\s+/g, " ").trim();
                inl.textContent = nt.length > 40 ? nt.slice(0, 40) + "…" : nt;
                inl.title = nt;
            }
        }
    };

    // 从标注文档链接跳转过来（url 带 #syann=<id> 片段）：滚动到对应高亮并闪烁提示。
    // 高亮可能晚于首次调用渲染（懒加载页面），宿主会按间隔重试；成功后置闩不再重复滚动。
    window.__syAnnFocus = function (id) {
        if (!id) return false;
        if (window.__syAnnFocused === id) return true;
        var safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "");
        if (!safeId) return false;
        var m = document.querySelector('mark.sy-ann-hl[data-ann-id="' + safeId + '"]');
        if (!m) return false;
        window.__syAnnFocused = id;
        // 瞬时滚动（不用 smooth）：smooth 依赖 rAF，页签在后台（浮动窗在前台）时
        // rAF 被节流导致平滑滚动不生效;瞬时滚动后台也能跳到位
        try { m.scrollIntoView({ block: "center" }); } catch (e) { m.scrollIntoView(); }
        m.classList.add("sy-ann-flash");
        setTimeout(function () { m.classList.remove("sy-ann-flash"); }, 1800);
        return true;
    };
})();
