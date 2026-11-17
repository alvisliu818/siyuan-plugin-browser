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
        ".sy-ann-bubble{position:fixed;z-index:2147483645;display:flex;align-items:center;gap:2px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.22);padding:3px;font-family:sans-serif;margin:0!important;right:auto!important;bottom:auto!important;}",
        ".sy-ann-bubble button{border:none;background:transparent;cursor:pointer;font-size:12px;padding:3px 10px;border-radius:4px;line-height:16px;}",
        ".sy-ann-bubble .sy-ann-create{background:#1a73e8;color:#fff;font-weight:600;}",
        ".sy-ann-pop{position:fixed;z-index:2147483645;max-width:340px;max-height:260px;overflow:auto;background:#fff;color:#222;border:none;outline:none;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.18);padding:10px 12px;font-size:13px;line-height:1.5;font-family:sans-serif;word-break:break-word;margin:0!important;right:auto!important;bottom:auto!important;}",
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
        ".sy-ann-pop-bar{display:flex;align-items:center;gap:4px;margin:-4px -4px 6px;padding:2px 4px;cursor:move;user-select:none;}",
        ".sy-ann-pop-bar .t{flex:1;font-size:11px;color:#999;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}",
        ".sy-ann-pop-bar button{border:none;background:transparent;cursor:pointer;font-size:13px;padding:1px 5px;border-radius:4px;color:#666;}",
        ".sy-ann-pop-bar button:hover{background:#eee;}",
        ".sy-ann-pop-bar button.on{color:#1a73e8;background:#dbeafe;}",
        ".sy-ann-pop-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;}",
        "@keyframes syAnnFlash{0%{box-shadow:0 0 0 0 rgba(255,140,0,.85);}70%{box-shadow:0 0 0 12px rgba(255,140,0,0);}100%{box-shadow:0 0 0 0 rgba(255,140,0,0);}}",
        ".sy-ann-flash{animation:syAnnFlash 0.9s ease-out 2;}",
        ".sy-ann-rect{position:absolute;box-sizing:border-box;border:2px solid rgba(255,170,0,.85);background:rgba(255,213,0,.12);cursor:pointer;z-index:2147483640;border-radius:2px;}",
        ".sy-ann-rect:hover{background:rgba(255,170,0,.2);}",
        ".sy-ann-capture{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;cursor:crosshair;background:rgba(0,0,0,.06);}",
        ".sy-ann-capture-box{position:fixed;border:1px dashed #1a73e8;background:rgba(26,115,232,.12);pointer-events:none;}",
        ".sy-ann-capture-tip{position:fixed;left:8px;top:8px;z-index:2147483647;background:#1a73e8;color:#fff;font-size:12px;padding:3px 8px;border-radius:4px;font-family:sans-serif;}",
        ".sy-ann-bubble .sy-ann-remove{color:#d93025;font-size:11px;padding:3px 6px;}"
    ].join("");

    function ensureStyle() {
        if (document.getElementById("sy-ann-style")) return;
        var s = document.createElement("style");
        s.id = "sy-ann-style";
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    var list = window.__syAnnList = [];
    var removeVisible = true;
    var captureId = null;     // 框选模式:正在为哪条标注重新框选(null=新建)
    var reanchorPending = null; // 文字改锚模式:待重新选中的标注 id // 选区气泡是否显示「取消高亮/小字」（宿主设置开关，__syAnnInit/SetRemoveVisible 下发）

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
        if (ann.hlOff === true) return 0; // 已取消高亮：不再包裹（重开页面 fetchAnnotations 带回 hlOff）
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
        // 内联小字：高亮后附截断的批注摘要，页面内不点开即可快速浏览（不存在则补建）
        if (wrapped && ann.inlineOff !== true) upsertInline(renderedId, ann.note);
        return wrapped;
    }

    // 内联小字写入/更新：新建标注时批注为空、只有高亮没有小字元素，之后写入的
    // 批注经 __syAnnSetNotes 回刷时必须补建元素，否则页内永远不显示（刷新页面才出现）
    function upsertInline(safeId, note) {
        var nt = String(note || "").replace(/\s+/g, " ").trim();
        try {
            var inl = document.querySelector('.sy-ann-inline[data-ann-id="' + safeId + '"]');
            if (!nt) {
                if (inl) inl.remove();
                return;
            }
            if (!inl) {
                if (!inlineVisible) return;
                var marks = document.querySelectorAll('mark.sy-ann-hl[data-ann-id="' + safeId + '"]');
                var lastMark = marks[marks.length - 1];
                if (!lastMark || lastMark.querySelector(".sy-ann-inline")) return;
                inl = document.createElement("span");
                inl.className = "sy-ann-inline";
                inl.setAttribute("data-ann-id", safeId);
                lastMark.appendChild(inl);
            }
            inl.textContent = nt.length > 40 ? nt.slice(0, 40) + "…" : nt;
            inl.title = nt;
        } catch (e) { /* 节点已失效等情况忽略 */ }
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
    var popDrag = false;      // 拖拽/缩放进行中：不收起小窗
    var suppressClick = false; // 拖拽结束的 click 不当作「点别处」
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
            if (act === "pin") { popPinned = !popPinned; b.classList.toggle("on", popPinned); return; }
            if (act === "edit") { hidePop(true); window.__syAnnOpen = { id: id, x: 0, y: 0, edit: true }; }
            else if (act === "close") { hidePop(true); }
        });
        // 拖拽移动（标题栏，transform 合成层免每帧布局）+ 右下角缩放
        p.addEventListener("mousedown", function (e) {
            var onBtn = e.target.closest ? e.target.closest("button") : null;
            var bar = e.target.closest ? e.target.closest(".sy-ann-pop-bar") : null;
            var rz = e.target.closest ? e.target.closest(".sy-ann-pop-resize") : null;
            if (bar && !onBtn) {
                e.preventDefault();
                popDrag = true; suppressClick = true; cancelPopHide();
                var sx = e.clientX, sy = e.clientY;
                var mv = function (ev) { p.style.transform = "translate(" + (ev.clientX - sx) + "px," + (ev.clientY - sy) + "px)"; };
                var up = function (ev) {
                    document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
                    var r0 = p.getBoundingClientRect();
                    p.style.transform = "";
                    var nx = Math.round(r0.left), ny = Math.round(r0.top);
                    p.style.left = nx + "px"; p.style.top = ny + "px";
                    setPos("sy-ann-pop", nx, ny);
                    popDrag = false;
                };
                document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
            } else if (rz) {
                e.preventDefault(); e.stopPropagation();
                popDrag = true; suppressClick = true; cancelPopHide();
                var sx2 = e.clientX, sy2 = e.clientY;
                var r1 = p.getBoundingClientRect();
                var w0 = r1.width, h0 = r1.height;
                var mv2 = function (ev) {
                    var w = Math.max(220, Math.min(window.innerWidth - 20, w0 + ev.clientX - sx2));
                    var h = Math.max(120, Math.min(window.innerHeight - 20, h0 + ev.clientY - sy2));
                    p.style.maxWidth = "none"; p.style.maxHeight = "none";
                    p.style.width = w + "px"; p.style.height = h + "px";
                };
                var up2 = function () { document.removeEventListener("mousemove", mv2); document.removeEventListener("mouseup", up2); popDrag = false; };
                document.addEventListener("mousemove", mv2); document.addEventListener("mouseup", up2);
            }
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
        var html = '<div class="sy-ann-pop-bar"><span class="t">标注</span>' +
            '<button data-ann-act="pin" class="' + (popPinned ? "on" : "") + '" title="固定（点别处不消失）">📌</button>' +
            '<button data-ann-act="close" title="关闭">×</button></div>';
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
        html += '<div class="sy-ann-pop-resize" title="拖动缩放"></div>';
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

    // 悬浮停留 300ms → 开/复用 OS 浮动窗（可移出页面/思源边界）;移开取消停留计时
    var hoverT = null;
    document.addEventListener("mouseover", function (e) {
        var m = e.target.closest ? e.target.closest(".sy-ann-hl,.sy-ann-inline") : null;
        if (!m) return;
        var id = m.getAttribute("data-ann-id");
        var x = e.clientX, y = e.clientY;
        if (hoverT) clearTimeout(hoverT);
        hoverT = setTimeout(function () {
            hoverT = null;
            window.__syAnnOpen = { id: id, x: Math.round(x), y: Math.round(y), hover: true };
        }, 300);
    }, true);
    document.addEventListener("mouseout", function (e) {
        var m = e.target.closest ? e.target.closest(".sy-ann-hl,.sy-ann-inline") : null;
        if (!m) return;
        if (hoverT) { clearTimeout(hoverT); hoverT = null; }
        window.__syAnnHoverEnd = { id: m.getAttribute("data-ann-id") };
    }, true);

    // 点击高亮/内联小字 → 固定快速小窗（不开思源窗口）;「在思源编辑」按钮才开。点别处收起
    document.addEventListener("click", function (e) {
        if (suppressClick) { suppressClick = false; return; }
        var inPop = e.target.closest ? e.target.closest("#sy-ann-pop") : null;
        if (inPop) return;
        var m = markAtPoint(e.clientX, e.clientY);
        if (!m) { hidePop(); return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        hidePop(true);
        // 点击开 OS 浮动窗（可拖出页面/思源边界、缩放、固定）;悬浮才是页内预览
        window.__syAnnOpen = {
            id: m.getAttribute("data-ann-id"),
            x: Math.round(e.clientX),
            y: Math.round(e.clientY),
        };
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
            '<button class="sy-ann-remove" data-ann-act="unhl" style="' + (removeVisible ? "" : "display:none;") + '">取消高亮</button>' +
            '<button class="sy-ann-remove" data-ann-act="uninline" style="' + (removeVisible ? "" : "display:none;") + '">取消小字</button>' +
            '<button class="sy-ann-remove" data-ann-act="uninline" style="' + (removeVisible ? "" : "display:none;") + '">取消小字</button>' +
            '<button class="sy-ann-remove" data-ann-act="reanchor" style="display:none" title="把这条标注改锚到当前选区(批注保持对应)">改锚</button>' +
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
            } else if (act === "reanchor" && b.__ann) {
                // 文字改锚:换锚点文字与高亮位置,批注内容保持对应(宿主写回)
                window.__syAnnReanchor = {
                    id: reanchorPending || b.__ann.id || "",
                    quote: b.__ann.quote,
                    prefix: b.__ann.prefix,
                    suffix: b.__ann.suffix,
                };
                reanchorPending = null;
                b.__ann = null;
                try { window.getSelection().removeAllRanges(); } catch (err) {}
            } else if ((act === "unhl" || act === "uninline") && b.__ann) {
                // 取消高亮/小字：只动页内显示，宿主把状态写回锚点属性（标注文档不删）
                window.__syAnnRemove = {
                    kind: act === "unhl" ? "hl" : "inline",
                    id: b.__ann.id || "",
                    quote: b.__ann.quote,
                    prefix: b.__ann.prefix,
                    suffix: b.__ann.suffix,
                };
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
            // 选区与已有高亮相交时带上标注 id：取消操作直接命中，不受同文重复标注干扰
            var hitId = "";
            try {
                var marks = document.querySelectorAll("mark.sy-ann-hl[data-ann-id]");
                for (var mi = 0; mi < marks.length; mi++) {
                    if (range.intersectsNode(marks[mi])) { hitId = marks[mi].getAttribute("data-ann-id") || ""; break; }
                }
            } catch (err) {}
            var b = ensureBubble();
            b.__ann = { quote: quote, prefix: pre, suffix: suf, id: hitId };
            // 改锚按钮:改锚模式挂起,或选区压着已有高亮(就地改锚)
            var reBtn = b.querySelector('[data-ann-act="reanchor"]');
            if (reBtn) reBtn.style.display = (reanchorPending || hitId) ? "" : "none";
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

    window.__syAnnInit = function (items, showInline, showRemove) {
        ensureStyle();
        if (showInline !== undefined) inlineVisible = !!showInline;
        if (showRemove !== undefined) removeVisible = !!showRemove;
        list.length = 0;
        for (var i = 0; i < (items || []).length; i++) list.push(items[i]);
        window.__syAnnRender();
        syncRemoveBtns();
    };

    // 设置开关：显示/隐藏页内批注小字
    window.__syAnnSetInlineVisible = function (v) {
        inlineVisible = !!v;
        var inls = document.querySelectorAll(".sy-ann-inline");
        for (var i = 0; i < inls.length; i++) inls[i].style.display = inlineVisible ? "" : "none";
    };

    // 设置开关：显示/隐藏选区气泡「取消高亮/小字」按钮
    window.__syAnnSetRemoveVisible = function (v) {
        removeVisible = !!v;
        syncRemoveBtns();
    };

    function syncRemoveBtns() {
        var btns = document.querySelectorAll("#sy-ann-bubble .sy-ann-remove");
        for (var i = 0; i < btns.length; i++) btns[i].style.display = removeVisible ? "" : "none";
    }

    // 取消高亮（宿主已写回锚点属性）：去 mark 连带其内联小字；列表项打标记防懒加载重试重新包裹
    window.__syAnnSetMark = function (id) {
        for (var j = 0; j < list.length; j++) {
            if (String(list[j].id) === String(id)) list[j].hlOff = true;
        }
        removeMarks(String(id));
    };

    // 只取消小字：保高亮
    window.__syAnnSetInlineOff = function (id) {
        for (var j = 0; j < list.length; j++) {
            if (String(list[j].id) === String(id)) list[j].inlineOff = true;
        }
        removeInline(String(id).replace(/[^A-Za-z0-9_-]/g, ""));
    };

    function removeMarks(id) {
        var safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "");
        var marks = document.querySelectorAll('mark.sy-ann-hl[data-ann-id="' + safeId + '"]');
        for (var i = 0; i < marks.length; i++) {
            var m = marks[i];
            var p = m.parentNode;
            if (!p) continue;
            while (m.firstChild) p.insertBefore(m.firstChild, m);
            p.removeChild(m);
            try { p.normalize(); } catch (err) {}
        }
        // 框选标注的矩形 overlay 一并移除
        var rects = document.querySelectorAll('.sy-ann-rect[data-ann-id="' + safeId + '"]');
        for (var r = 0; r < rects.length; r++) {
            if (rects[r].parentNode) rects[r].parentNode.removeChild(rects[r]);
        }
        removeInline(safeId);
    }

    function removeInline(safeId) {
        var inls = document.querySelectorAll('.sy-ann-inline[data-ann-id="' + safeId + '"]');
        for (var k = 0; k < inls.length; k++) {
            if (inls[k].parentNode) inls[k].parentNode.removeChild(inls[k]);
        }
    }

    window.__syAnnRender = function () {
        for (var i = 0; i < list.length; i++) {
            if (list[i].kind === "rect") wrapRectOne(list[i]); else wrapOne(list[i]);
        }
    };

    window.__syAnnApply = function (items) {
        ensureStyle();
        for (var i = 0; i < (items || []).length; i++) {
            list.push(items[i]);
            if (items[i].kind === "rect") wrapRectOne(items[i]); else wrapOne(items[i]);
        }
    };

    // 编辑后刷新批注文本（内联小字 + 缓存），不重新包裹高亮
    window.__syAnnSetNotes = function (items) {
        for (var i = 0; i < (items || []).length; i++) {
            var it = items[i];
            if (it.kind === "rect") {
                // 框选标注:更新 overlay 位置与批注小字(重新框选后宿主推送)
                var safeR = String(it.id || "").replace(/[^A-Za-z0-9_-]/g, "");
                var r = document.querySelector('.sy-ann-rect[data-ann-id="' + safeR + '"]');
                if (r && it.rect) {
                    r.style.left = it.rect.x + "px";
                    r.style.top = it.rect.y + "px";
                    r.style.width = it.rect.w + "px";
                    r.style.height = it.rect.h + "px";
                    var lbl = r.querySelector(".sy-ann-inline");
                    if (lbl) lbl.textContent = it.note || "";
                }
                for (var j2 = 0; j2 < list.length; j2++) {
                    if (String(list[j2].id) === String(it.id)) {
                        list[j2].note = it.note;
                        list[j2].rect = it.rect;
                        list[j2].shot = it.shot;
                    }
                }
                continue;
            }
            for (var j = 0; j < list.length; j++) {
                if (String(list[j].id) === String(it.id)) {
                    list[j].note = it.note;
                    if (it.color) list[j].color = it.color;
                    if (it.tags) list[j].tags = it.tags;
                }
            }
            if (it.color) applyColor(it.id, it.color);
            var safeId = String(it.id || "").replace(/[^A-Za-z0-9_-]/g, "");
            upsertInline(safeId, it.note);
        }
    };

    // 从标注文档链接跳转过来（url 带 #syann=<id> 片段）：滚动到对应高亮并闪烁提示。
    // 高亮可能晚于首次调用渲染（懒加载页面），宿主会按间隔重试；成功后置闩不再重复滚动。
    // ===== 框选标注:遮罩 + 拖拽取框(视口内) =====
    // 坐标:overlay 移除后宿主 capturePage 按**视口坐标**截屏;同时上报**文档坐标**
    // (视口坐标 + 滚动偏移)供矩形 overlay 在页面里持久定位
    window.__syAnnCaptureStart = function (id) {
        if (document.getElementById("sy-ann-capture")) return;
        captureId = id || null;
        var ov = document.createElement("div");
        ov.id = "sy-ann-capture";
        ov.className = "sy-ann-capture";
        var tip = document.createElement("div");
        tip.className = "sy-ann-capture-tip";
        tip.textContent = "拖拽框选区域,Esc 取消";
        var box = document.createElement("div");
        box.className = "sy-ann-capture-box";
        box.style.display = "none";
        ov.appendChild(tip);
        ov.appendChild(box);
        var sx = 0, sy = 0, dragging = false;
        ov.addEventListener("mousedown", function (e) {
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            box.style.left = sx + "px"; box.style.top = sy + "px";
            box.style.width = "0px"; box.style.height = "0px";
            box.style.display = "";
        });
        ov.addEventListener("mousemove", function (e) {
            if (!dragging) return;
            e.preventDefault();
            var x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
            box.style.left = x + "px"; box.style.top = y + "px";
            box.style.width = Math.abs(e.clientX - sx) + "px";
            box.style.height = Math.abs(e.clientY - sy) + "px";
        });
        ov.addEventListener("mouseup", function (e) {
            e.preventDefault();
            e.stopPropagation();
            var w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
            var vx = Math.min(sx, e.clientX), vy = Math.min(sy, e.clientY);
            var done = function () {
                if (ov.parentNode) ov.parentNode.removeChild(ov);
                captureId = null;
            };
            if (w < 10 || h < 10) { done(); return; }
            // 遮罩先移除再上报:宿主截屏不能把遮罩截进去
            done();
            var vrect = { x: Math.round(vx), y: Math.round(vy), w: Math.round(w), h: Math.round(h) };
            window.__syAnnRectCaptured = {
                id: id,
                rect: { x: vrect.x + (window.scrollX || 0), y: vrect.y + (window.scrollY || 0), w: vrect.w, h: vrect.h },
                vrect: vrect,
            };
        });
        document.body.appendChild(ov);
    };

    // 框选标注渲染:文档坐标矩形 overlay + 角标批注小字
    function wrapRectOne(item) {
        if (!item || !item.rect) return;
        if (item.hlOff === true) return;
        var safeId = String(item.id || "").replace(/[^A-Za-z0-9_-]/g, "");
        var r = document.querySelector('.sy-ann-rect[data-ann-id="' + safeId + '"]');
        if (r) return; // 已渲染(懒加载重试不重复)
        r = document.createElement("div");
        r.className = "sy-ann-rect";
        r.setAttribute("data-ann-id", safeId);
        r.style.left = item.rect.x + "px";
        r.style.top = item.rect.y + "px";
        r.style.width = item.rect.w + "px";
        r.style.height = item.rect.h + "px";
        r.addEventListener("mouseenter", function () {
            window.__syAnnOpen = { id: item.id, x: item.rect.x, y: item.rect.y, hover: true };
        });
        r.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            window.__syAnnOpen = { id: item.id, x: item.rect.x, y: item.rect.y };
        });
        if (item.note && inlineVisible) {
            var lbl = document.createElement("div");
            lbl.className = "sy-ann-inline";
            lbl.setAttribute("data-ann-id", safeId);
            lbl.textContent = item.note;
            r.appendChild(lbl);
        }
        document.body.appendChild(r);
    }

    // 文字改锚完成:去旧高亮 → 替换列表条目 → 包新文字
    window.__syAnnReanchorDone = function (item) {
        if (!item || !item.id) return;
        removeMarks(String(item.id));
        for (var j = 0; j < list.length; j++) {
            if (String(list[j].id) === String(item.id)) { list[j] = item; break; }
        }
        window.__syAnnRender();
    };

    // Escape 优先取消框选模式
    var _origKeydown = document.addEventListener;
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && captureId !== null) {
            var ov = document.getElementById("sy-ann-capture");
            if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
            captureId = null;
        }
    }, true);

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
        // 重复跳转也能重新闪：先移除类+强制 reflow 再添加，重启动画
        m.classList.remove("sy-ann-flash");
        void m.offsetWidth;
        m.classList.add("sy-ann-flash");
        setTimeout(function () { m.classList.remove("sy-ann-flash"); }, 1900);
        return true;
    };
})();
