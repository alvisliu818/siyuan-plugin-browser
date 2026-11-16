# 暴力猴（VM 2.50.0 MV3）弹窗 v26 修复 —— 未完成任务交接文档

日期：2026-11-16（下午续接上午《violentmonkey-popup-empty-list-2026-11-16.md》第 5 节"已知副作用"）
状态：**已完成（2026-11-16 晚）**——第 4 节的剩余编辑未按原方案实施：改为「重放前确定性补齐」
（refillSetPopupCache，fetch get-data.js 前补齐并确认缓存）+ Run 补报（根治横幅复发），
弃用 60ms 密集补填。四场景活体验证全过（新开/toggle/冷SW/快速开关），详见
《violentmonkey-popup-empty-list-2026-11-16.md》第 5 节。本文档其余部分作为过程档案保留。
现场：主库 `E:\HOME\SiYuan`（内核 6806，CDP 9221），VM electronId `lohncnmkmfabdgoifacpkahlnnlhiiai`，扩展目录 `E:/HOME/SiYuan/data/storage/petal/siyuan-plugin-browser/extensions/edge-eeagobfjdenkkddmbclomhiblgggliao-19f6031`

## 0. 一句话任务

用户报：弹窗出现 "Violentmonkey was restarted. Please reload the tab" 横幅 + 脚本名红色删除线（脚本实际在运行）。
v26 方案（badge.inject 条件放行 + SetPopup 预投递）已部署并消除了横幅，但活体验证发现**弹窗列表变空**——根因是 popup 文档 ERR_ABORTED 双拉把 pop-on-read 缓存窗口吃空。剩余工作 = 完成就位后的密集补填（代码已写一半）+ 端到端复验。

## 1. 症状与根因链（全部已实证）

### 用户症状的根因（上午报告第 5 节，v25 的副作用）
- v25 垫片把 `badge.inject` 恒读 undefined → VM `initPopup()`（`src/background/utils/popup-tracker.js:22`）的 `reset=true` 恒成立 → 走 `augmentSetPopup` 补算路径：
  - `isInjectable()`（popup-tracker.js:82，垫片 registerInjector/executeScript 恒成功）→ `state===true` → 补算脚本非空 → `failure=[failureReasonRestarted, IS_APPLIED]` → **横幅** + `injectInto='off'`（总开关关闭态）
  - `GetMoreIds` 现算的 ids 态恒为 `more` → popup/index.js:78 `script.failed = ... || more` → app.vue 的 `failed` class → **红色删除线**

### v26 已部署的修复（见 `src/extensions/extensionHost.ts` 0d2 节 + SHIM_VER v26）
- `badge.inject` **条件放行**：仅当 SW 全局 `__sySetPopupSeenAt["1"]` 新鲜（5min TTL 内 = SetPopup 缓存生命周期）时读真值（reset=false → 无横幅、缓存命中路径）；否则读 undefined 回落 v25 保底
- 真值经 WeakMap 保存 + `__syBadgesInject` 持久化镜像（accessor 不可枚举、clone 丢键，SW 重启后回种）
- 配套 `cs-runtime.ts`：端口 onDisconnect 真实现（旧空壳导致 popupTabs 残留吞 SetPopup）、portPoll 打 `__syPortPollAt` 时间戳、precache 重做（ids 态修正 more→content + CacheLoad 验证 + 投递标记 + 非 VM 早退）
- **已部署生效**：sw.js 头标记 `/* sy-bg-shim:v26:1pjn8cj */`（18:26 写入），主库+测试库 index.js 均为 v26 构建（18:24）

### 新发现的根因（本下午实证，**当前弹窗空列表的直接原因**）
VM popup 的数据链（读源码钉死）：
1. `popup/index.html` 第一个 `<script src=/get-data.js?popup>` → SW 的 `onfetch`（`src/background/sw.js:32`）→ `makeDataResponse('popup')` → **`await initPopup()`** → 响应体 `var BGDATA={opts, popup:...}` → 页面播种
2. `popup/index.js:133`：`BGDATA.popup || await sendCmdDirectly('InitPopup')` —— BGDATA.popup 恒为 truthy 数组（即使 cached 为 null）→ **InitPopup 兜底永不走**
3. `popup/index.js:152`：`if (cached) { for (const id in cached) setPopup(...cached[id]); }` —— cached 空 → 列表空
4. **弹窗 webview ERR_ABORTED 重载**（宿主 overlay 归位/复用语义）→ get-data.js **fetch 两次**（实测 7647ms / 7864ms，间隔仅 217ms）
5. `initPopup` 的 `cache.pop('SetPopup1')` 是 **pop-on-read**：fetch#1 吃掉预填条目 → fetch#2（217ms 后）pop 到**空缓存** → `BGDATA.popup[0]=null` → 空列表
6. 宿主垫片**没有实现** VM 的 SW→扩展页广播（`BroadcastChannel('bus')`，`src/common/messaging-sw.js:12` + `src/background/utils/broadcast.js`）→ popup 没有任何二次初始化路径（端口也接不到消息）→ **一锤子买卖，二拉空 = 永久空**
7. 当前的就位后补打 cadence 是 1200ms（cs-runtime.ts:290-293），**错过 217ms 窗口** —— 这就是要修的点

关键佐证（避免下次重新踩）：
- **BGDATA 是读一次即删的 Proxy**（`src/common/safe-globals.js:47`：`get: (obj,k,_) => (_ = obj[k], delete obj[k], _)`）——事后在 popup 里探 `globalThis.BGDATA` 永远是 `{}`，**不代表没收到数据**（本下午因此误判过一轮）
- 打包后的 SW handler 回包协议（实证 1ms 返回 `true`）：同步返回恒 `true`，真实结果经第 3 参 sendResponse 以 `[result, error]` 对送达 → 现有 call helper 的轮询协议是对的，**别改成直接 await**
- 态修正能生效的机制：`getScriptsByURL(url, isTop, errors, prevIds)`（db.js:332）对 `id in prevIds` 的脚本 **跳过** → SetPopup data 里传 `{"1":"content"}` 能穿透 augmentSetPopup 保持 content 态
- 删除线/正常运行判定（popup/index.js:76-78）：`state===content → script.runs=true`（正常）；`state===more → script.failed=true`（红删除线）

## 2. VM 关键源码索引（E:\HOME\Code\violentmonkey）

| 文件 | 内容 |
|---|---|
| `src/background/utils/popup-tracker.js` | initPopup/reset 逻辑、SetPopup 命令、popupTabs、onPopupOpened |
| `src/background/sw.js:17-41` | makeDataResponse/onfetch —— get-data.js 伺服与 BGDATA 生成 |
| `src/background/utils/cache.js` | CacheLoad/CachePop 命令，lifetime 5min |
| `src/background/utils/db.js:332` | getScriptsByURL 的 prevIds 跳过语义 |
| `src/common/safe-globals.js:47` | BGDATA 读删 Proxy |
| `src/common/messaging-sw.js` | BroadcastChannel('bus') 广播（宿主未实现） |
| `src/popup/index.js:128-158` | initialize/BGDATA/port 连接（connect 后不再主动发消息） |
| `src/popup/views/app.vue:85-98` | `failed`/`runs` class 绑定（删除线渲染处） |

## 3. 当前代码状态（精确盘点）

### 已完成并已部署（构建 18:24，扩展 sw.js 18:26 已换 v26）
1. `src/extensions/extensionHost.ts`
   - 0d2 节完整（420-549 行）：chrome.storage.session get/set 包装、badges Proxy、inject accessor 条件放行、`__syBadgesInject` 镜像、`SY_SP_TTL=300000`
   - `SHIM_VER = "v26"`（227 行附近）+ 版本历史注释（v26 条目已加）
   - 模板字符串正则已用 `\\d` 双反斜杠（`/^\\d+$/`），无 cook 错误
2. `src/extensions/cs-runtime.ts`
   - 端口对象 `onDisconnect` 真实现 + `disconnect()` 派发 `__syDiscFns`（1778-1795 行区域）
   - `portPoll` 写 `__syPortPollAt[pid] = Date.now()`（1870-1893 行区域）
   - `precacheSetPopupForPopup`：端口清理 + `__syLastFedTab` 喂入 + GetMoreIds 态修正 + SetPopup + CacheLoad 验证 + `__sySetPopupSeenAt` 标记 + 非 VM 早退
   - **fire 的 expr 已改为返回 JSON `{r: "<结果串>", ids: <态修正ids>}`，宿主侧解析后把 ids 存进 `lastIdsJson`（刚编辑完，见第 4 节）**

### ⚠️ 工作区当前状态：编译不过 / 未构建未部署
**`cs-runtime.ts` 里 `fire` 内引用了 `lastIdsJson` 但变量声明还没加**（会 TS2304）。剩余编辑清单见第 4 节，全部做完再 build+deploy。

## 4. 剩余编辑（下次直接照做）

### 4a. `cs-runtime.ts` precacheSetPopupForPopup —— 补三段代码

**(1) 变量声明**（函数内、`const extInfo = manager.findExt(...)` 判 VM 之后、`const fire = ...` 之前）：

```ts
const extUrl = "chrome-extension://" + electronId + "/popup/index.html";
const pageSender = JSON.stringify({ id: electronId, url: pageUrl, tab: { id: 1, url: pageUrl }, frameId: 0 });
// 本轮 GetMoreIds 的态修正结果（content 态）—— 密集补填复用（见 tick）
let lastIdsJson: string | null = null;
```
注意：现有代码里 `extUrl`/`pageSender` 声明在 `fire` 内部（`const fire = async (first) => {` 的 try 块里，`const extUrl = ...` 那行在四步链注释之后）。把它们**上移到函数级**并删除 fire 内的重复声明，`lastIdsJson` 一并声明。

**(2) tick 函数**（放在 `fire` 定义之后）—— 轻量补填，一轮 ≈1 次 SW 求值：

```ts
// 密集补填：SetPopup（复用上轮 content 态 ids）+ 投递标记，fire-and-forget。
// popup 文档 ERR_ABORTED 重载会重新 fetch get-data.js，其 initPopup 走 cache.pop-on-read
// —— 首拉吃掉预填条目后，重载文档的二拉（实测 +217ms）在补打空窗期 pop 到空缓存
// → BGDATA.popup[0]=null → 空列表。就位后 ~5s 内每 ~90ms 补填一轮（每轮 1 次求值，
// augment 内存级开销），保证任一次 pop 后 ≤150ms 内有新条目，二拉必命中；之后转
// 稀疏维持。
const tick = async (): Promise<void> => {
    if (!lastIdsJson) return;
    try {
        const expr = `(async () => {
            const fns = self.__syOnMessageHandlers || [];
            if (fns.length) {
                const msg = { cmd: "SetPopup", data: { ids: ${lastIdsJson}, injectInto: "auto", menus: {} }, url: ${JSON.stringify(pageUrl)}, top: 1 };
                for (const fn of fns) {
                    try {
                        const p = fn(msg, ${pageSender}, function () {});
                        if (p && typeof p.then === "function") p.catch(() => {});
                    } catch (e) {}
                }
                self.__sySetPopupSeenAt = self.__sySetPopupSeenAt || {};
                self.__sySetPopupSeenAt["1"] = Date.now();
            }
        })()`;
        await evalInSwByElectronId(electronId, expr);
    } catch {}
};
```
（SetPopup handler 同步返回 true、结果无意义 → 直接调 `fn(msg, sender, noop)` fire-and-forget，**不要**走 call 轮询，否则每轮多耗秒级。）

**(3) 替换就位后补打循环**（现 287-293 行区域 `void firstP.then(() => { setInterval fire 1200ms × 15 })`）：

```ts
// 就位后：密集补填（5s，每 ~90ms 一轮）→ 稀疏维持（fire-and-forget，不阻塞调用方）。
void firstP.then((ok) => {
    if (!ok) return;
    void (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 5000) {
            await tick();
            await new Promise((r) => setTimeout(r, 60));
        }
        let n = 0;
        const t = setInterval(() => { void fire(false); if (++n >= 10) clearInterval(t); }, 1200);
    })();
});
```

**(4) 顺带更新函数头 doc 注释**（156 行上方 v26 注释块）加一条：
`d) 就位后 5s 密集补填 —— ERR_ABORTED 二拉吃掉 pop-on-read 缓存 → 空列表的根治`。

### 4b. `cs-runtime.ts` routePortMessage —— 端口出生打点（防误杀）

在 SW 侧端口创建 expr（`self.__syPorts[${pidJson}] = port;` 之后）加：
```js
// 出生打点：世界侧泵 600ms 后接管；precache 的 3s 无打点判死会误杀
// "刚创建、泵首拍未到"的活端口
try { self.__syPortPollAt = self.__syPortPollAt || {}; self.__syPortPollAt[${pidJson}] = Date.now(); } catch (eTS) {}
```
在复用分支（`listeners = port.__syListeners || [];` 之后）加：
```js
// 复用 = 世界侧活着在发消息：刷新活跃戳（防泵停但消息仍流的会话被误判陈旧）
try { (self.__syPortPollAt || (self.__syPortPollAt = {}))[${pidJson}] = Date.now(); } catch (eTR) {}
```
端口清理条件保持 `!last || now - last > 3000` 不变。

### 4c. 构建部署验证闭环

```bash
cd "E:/HOME/Code/siyuan/siyuan-plugin-browser"
yarn webpack --config webpack.config.js --mode production   # 唯一门禁（tsc 有预存 tsconfig baseUrl 报错，忽略）
yarn node scripts/zip.js                                     # 重建 dist/package.zip（可选）
cp .src/index.js "E:/HOME/SiYuan/data/plugins/siyuan-plugin-browser/index.js"
cp .src/index.js "E:/HOME/Local/siyuan-test-ws/data/plugins/siyuan-plugin-browser/index.js"
# 重载主窗（插件无缓存层，reload 即新代码；插件 onload 会自动换写扩展 sw.js 并 reconcileNative 重载扩展）
node "E:/HOME/Code/.openclaw/tmp/vm-diag/win-eval.cjs" "location.reload(); 'reloading main window'"
# 确认垫片换版（头标记应含 v26 与新 hash）：
head -c 60 "E:/HOME/SiYuan/data/storage/petal/siyuan-plugin-browser/extensions/edge-eeagobfjdenkkddmbclomhiblgggliao-19f6031/sw.js"
```

### 4d. 端到端复验流程（工具都在 `E:\HOME\Code\.openclaw\tmp\vm-diag\`）

⚠️ 前置陷阱：**location.reload() 后百度页签 webview 可能卡在 about:blank**（健康监控 "webview loading stuck >90s, rebuilding" 循环，本下午实测）。表象是 popup "cannot run userscripts"——那是 url 空，不是 v26 的锅。恢复方法：URL 栏提交导航：
```js
// win-eval.cjs：
(() => { const tab = document.querySelector('.sy-browser-tab'); const bar = tab.querySelector('.sy-browser-urlbar');
  bar.value = 'https://www.baidu.com/s?ie=utf-8&tn=15007414_4_pg&ch=1&wd=%E4%B8%9C%E6%96%B9';
  bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()
```

验证步骤：
1. 确认百度 webview URL 是 http(s)：`win-eval.cjs` `"(() => { const w = document.querySelector('.sy-browser-tab webview'); return w.getURL(); })()"`
2. 点击 VM 按钮：`win-eval.cjs` `"(() => { const b = [...document.querySelectorAll('.sy-browser-extbar [data-ext-id]')].find(x => x.dataset.extId === '1ah8ex1-2.50.0'); b.click(); return 'clicked'; })()"`
3. 等 ~10s，读弹窗内容（**在最新世界读，DOM 是共享的，body.innerText 即最终渲染**）：
```bash
POPUP_ID=$(curl -s http://127.0.0.1:9221/json/list | python -c "import json,sys; l=json.load(sys.stdin); p=[t for t in l if 'lohncnmkmfabdgoifacpkahlnnlhiiai/popup/index.html' in t.get('url','')]; print(p[0]['id'] if p else 'NONE')")
node tgt-eval.cjs "$POPUP_ID" "document.body.innerText"
node tgt-eval.cjs "$POPUP_ID" "JSON.stringify({failed: document.querySelectorAll('.script.failed').length, runs: document.querySelectorAll('.script.runs').length, banners: document.body.innerText.includes('was restarted')})"
```
4. **判定标准**：body 含 `Matched scripts` + `searchEngineJump 搜索引擎快捷跳转`；`failed=0`（无删除线）；`banners=false`（无横幅）；`runs>=1`
5. SW 状态复核：`tgt-eval.cjs "chrome-extension://lohncnmkmfabdgoifacpkahlnnlhiiai/sw.js" "JSON.stringify({fedTab: self.__syLastFedTab && self.__syLastFedTab.url, seenAt: self.__sySetPopupSeenAt})"` —— seenAt 应新鲜
6. 时序验证（可选）：`node e2e-fetchtrace.cjs` 观测 get-data 双拉间隔内补填是否落位
7. 场景矩阵：开→关→再开（toggle）、连续快速开关、冷 SW（先杀 SW 再开）、开着弹窗等 >5min（标记过期后重开）

### 4e. 若密集补填仍偶发漏窗的兜底（按需，未实施）

- 弹窗打开 ~5.5s 后查 popup webview DOM 的 `.script` 行数，为 0 且弹窗仍开 → `fire(false)` + `refreshForData()`（BrowserTab/PupupOverlay 有现成方法）重拉一次
- 长期正路：实现宿主的 SW→扩展页 onMessage 广播（把 SW 收到的命令转发到各扩展页世界的 `__syCsOnMessageFns`）—— VM 真实的实时更新路径

## 5. 环境事实速查

- 主窗 CDP 9221（start-sy-main.bat 拉起）；主窗 target 按 `type=='page' && url 含 6806` 选；**9222 无服务**
- VM 记录 id（toolbar 按钮 data-ext-id）：`1ah8ex1-2.50.0`；electronId：`lohncnmkmfabdgoifacpkahlnnlhiiai`
- 弹窗 overlay：`PopupOverlay.ts`（open 251 行；close=隐藏+归位 about:blank；refreshForData=437 行）；`BrowserTab.openExtensionPopup`（1263 行：wakeSw≤2.5s → feedTab≤3s → precache await ready≤8s → open → !ready 时 pp.then(refreshForData)）
- 主世界 fetch chrome-extension:// **确实会进 VM SW 的 onfetch**（实测 get-data.js?popup 返回 200 + 完整 BGDATA）—— Electron 内建扩展伺服走 SW
- 弹窗页面脚本由 ext-popup.ts 在自建世界重放（POPUP_JS_PRELUDE + remoteSrcs fetch+eval）；世界侧 runtime.connect 是**惰性**的（SW 端口首条 postMessage 才创建，cs-runtime.ts:2610 区域）→ popupTabs 实际不会因弹窗本身置位
- `grep -c` 数的是**行数**不是出现次数（CDP pretty-print 的 title+url 两行都匹配，曾误判"两个 SW target"）
- 探 SW 的工具脚本：`tgt-eval.cjs <targetId|url子串> '<js>'`（参数式）、`tgt-eval2.cjs <sel> <expr文件路径>`（文件式，长表达式用这个；顶层 return 要包 `(async () => {...})()`）
- 观测工具：`click-trace.cjs`（console 监听+点按钮+SW 状态）、`e2e-trace.cjs`（SW 命令/端口 swtrace 注入）、`e2e-fetchtrace.cjs`（onfetch 双拉观测）、`ctx-probe.cjs`（弹窗各执行世界枚举）

## 6. 收尾事项（验证通过后）

1. 更新 `docs/violentmonkey-popup-empty-list-2026-11-16.md`：第 5 节标记已消除，补 v26 实施细节与验证数据
2. 提交仓库（父仓库 E:\HOME\Code，siyuan-plugin-browser 的 src 被父 .gitignore 忽略——按上午 e17ed63 的提交方式处理 dist/或直接提交主仓库文档）
3. 沉淀到记忆：`memory/2026-11-16.md` 追加下午结论；方法论要点（BGDATA 读删 Proxy、pop-on-read 双拉、BroadcastChannel 缺位、grep -c 行数陷阱、reload 后 webview 卡死恢复法）
4. 测试库 e2e 点验（上午报告 4 节遗留项）
