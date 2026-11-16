# 暴力猴（VM 2.50.0 MV3）弹窗脚本列表为空 —— 结论报告

日期：2026-11-16
范围：`siyuan-plugin-browser` 宿主垫片适配（**未修改 Violentmonkey 源码**）
现场：主库 `E:\HOME\SiYuan`（内核 6806，CDP 9221），扩展 ID `lohncnmkmfabdgoifacpkahlnnlhiiai`，
目录 `edge-eeagobfjdenkkddmbclomhiblgggliao-19f6031`，已安装脚本 `searchEngineJump 搜索引擎快捷跳转`（`scr:1`）。

## 1. 症状

弹窗只渲染头部、`Find scripts for this site (GF) / OUJS`、页脚 `violentmonkey.github.io`，
脚本分组与脚本行完全不出现。用户诉求是适配扩展本身，不在插件里自建脚本引擎。

## 2. 证据链（逐项排除三个候选死点）

VM popup 链路：`popup initialize()` → `InitPopup` → `getActiveTab()` → `augmentSetPopup` → `getScriptsByURL` → `aliveScripts` → `setPopup()` → `store.scripts`。

| 环节 | 活体证据 | 结论 |
|---|---|---|
| `getActiveTab` / tabs.query 垫片 | `chrome.tabs.query({active:true,currentWindow:true})` 返回 tab id=1、`active:true`、baidu URL；`InitPopup` 的 `data.tab` 完整、`data.domain = "baidu.com"` | 正常，排除 |
| `GetTabDomain` / 可注入判定 | `InitPopup` 返回 `failure = [""]`；且 `Find scripts for this site` 可见（`app.vue:48` 要求 `store.injectable && store.domain`） | 正常，排除 |
| 数据库 / `aliveScripts` | `scr:1` 是正常对象（`enabled=1`、`removed=0`、`origMatch=true`）；`GetData({ids:["1"]})` 返回 `scriptsLen=1` | 正常，排除 |
| 匹配规则 | `GetMoreIds` 对 baidu 返回 `{"1":"more"}`（`*://**/*` 匹配成功） | 正常，排除 |
| **`InitPopup` 的 cached** | 修复前返回 `[undefined, {host,domain,tab}, [""]]` —— **第一项为空** | **断点在此** |

`popup/index.js:152` 的 `if (cached) { for (const id in cached) setPopup(...cached[id]); }` 因 `cached` 为空整段跳过，
`store.scripts` 保持 `[[], []]`（`popup/utils/index.js` 的 `emptyStore()`），列表空。

### 根因

VM `background/utils/popup-tracker.js::initPopup()`：

```js
let reset = !IS_FIREFOX && !failure[0] && badgeData[INJECT] === undefined;
let cachedSetPopup = cache.pop(getCacheKey(tabId));   // 纯内存，SW 重启即空
if (reset && (cachedSetPopup ? !cachedSetPopup[0] : cachedSetPopup = {})) {
  cachedSetPopup[0] = await augmentSetPopup(...);      // 唯一的补算路径
}
```

- 宿主用 `loadExtension` + `userScripts` **模拟**注入：VM 的 `setBadge()` / `resetBadgeData()`
  往内存写 `badges[tabId].inject = true`，`flushSession(kBadges, badges)` 再持久化到
  `chrome.storage.session`。实测磁盘值：
  `{"1":{"inject":true,"ids":[1],"total":1,...},"3":{...}}`。
- 但宿主的内容脚本链路**从未向 SW 发送 `SetPopup`**，所以 `cache` 里没有 `SetPopup<tabId>` 条目。
- 于是 `reset === false`（badge 说"已注入"）且 `cache.pop() === undefined`（缓存为空）：
  **既不取缓存，也不补算**。这是宿主伪环境特有的死锁，真实 Chrome 里内容脚本会重发 `SetPopup` 填上缓存。

上一轮总结把"毒键 `__sy*`"、ID 漂移、`loadData('***')` 列为嫌疑，经活体验证均与列表空无关：
`__sy*` 确实污染了 `scr:1.config`，但脚本元数据完好、`initializeDatabase` 正常完成。

## 3. 修复（只改宿主垫片）

`src/extensions/extensionHost.ts` 的 `injectBackgroundShims()`：

- 新增 `0d2` 节，包装 `chrome.storage.session.get` / `set`：
  - 把 `badges` 根对象包成 **Proxy**；已有条目与运行时新建条目都装上 `inject` 的
    accessor（**读恒 `undefined`、写入吞掉**），`enumerable:false` → structured clone 时该键直接消失。
  - `set` 写入时二次兜底，覆盖 `setBadge()` 新建的条目。
  - 只作用于 `badges` 键，其它扩展零影响。
- `SHIM_VER` `v24` → `v25`；标记含内容 hash，换版会自动重写扩展 `sw.js`、
  unload/load 原生扩展并清 SW 注册缓存。
- 不修改 VM 源码，不自建脚本引擎，`reset` 重新成立后由 VM 自己调
  `augmentSetPopup` → `getScriptsByURL` + `getData` 补算。

> 为什么第一版"只在 `get()` 里 delete inject"不够：VM 运行时还会把 `inject` 写回**内存**
> `badges`，而 `initPopup` 读的是内存对象不是磁盘。必须拿住根对象并持续中性化。
> Proxy 与 accessor 均已实测可安全通过 `chrome.storage.session` 的 structured clone。

提交：`e17ed63 fix(extensions): 修复暴力猴弹窗脚本列表为空`。

## 4. 验证

- `yarn typecheck`、`yarn build` 通过；产物含 `sy-bg-shim:v25` 与 `__syIsBadgeProxy`，无 v24 残留。
- 部署：构建产物（`.src/`）→ 主库与测试库 `data/plugins/siyuan-plugin-browser/`（diff 一致）。
- 主库扩展 `sw.js` 头变为 `/* sy-bg-shim:v25:43gaaa */`；SW 重启后
  `__syBadgeGuard=1`、`badges` 为 Proxy、条目 `inject` 读值 `undefined`。
- `InitPopup` 修复后返回：`cached={0:[...]}`、`frame0` 存在、`ids={"1":"more"}`、
  `scriptsLen=1`、脚本名 `searchEngineJump 搜索引擎快捷跳转`、`domain=baidu.com`。
- 真实弹窗（宿主 `tab.openExtensionPopup()` 打开）`body.innerText`：

  ```
  __MSG_extName__ 2.50.0 MV3
  Find scripts for this site (GF) / OUJS
  Matched scripts
  searchEngineJump 搜索引擎快捷跳转
  ```

  无手工注入的干净路径（reloadUI 后等宿主自动同步 tab）复验同样通过。
- 顺带确认：主库 / 测试库 `sw.js` 原先 MD5 不一致（主库 v25、测试库 v23/v24，因测试库窗口未启动）；
  已将测试库启用目录 `12k10go` 与副本 `19f6031` 的垫片同步，三处 MD5 现均为 `54395ce6112feca1154e8e0b8bf22710`。
- 测试库窗口未启动，**未做 e2e 实机点验**；插件产物与垫片文件已就位，启动后即生效。

## 5. 已知副作用 —— 已消除（v26 + v27，2026-11-16 下午/晚间）

### 5.1 横幅与红色删除线（v26 根除）

弹窗多出的 `Violentmonkey was restarted...` 横幅 + 脚本名红色删除线，根因是 v25 垫片把
`badge.inject` 恒读 undefined → `initPopup()` 的 `reset=true` 恒成立 → `augmentSetPopup`
补算路径把 `isInjectable()`（垫片恒成功）误判为「SW 重启」→ `failure=[failureReasonRestarted,
IS_APPLIED]`（横幅）+ `state=more`（删除线）。

v26（extensionHost 0d2 节 + cs-runtime 配套）：
- `badge.inject` **条件放行**：仅当 SW 全局 `__sySetPopupSeenAt[1]` 新鲜（5min TTL =
  SetPopup 缓存生命周期）时读真值（reset=false → 无横幅、缓存命中路径）；否则回落 v25 保底。
  真值经 WeakMap 保存 + `__syBadgesInject` 持久化镜像（accessor 不可枚举、clone 丢键，
  SW 重启后回种）。
- 端口 `onDisconnect` 真实现 + 端口出生/复用打点（`__syPortPollAt`）：popup 世界死后
  VM 的 `popupTabs` 残留会吞掉 SetPopup（"popupTabs[tabId] → return"），3s 无打点判死
  断开触发 VM 清理；出生打点防误杀「刚创建、泵首拍未到」的活端口。
- precache 投递链四步：断陈旧端口 → 喂 `__syLastFedTab`（冷 SW 内存态丢失）→
  GetMoreIds 现算 + 态修正 more→content（宿主隔离世界 = VM 语义 content 态 →
  runs=true 无删除线）→ SetPopup + CacheLoad 验证 + 投递标记。

### 5.2 弹窗空列表（v27 根治 —— ERR_ABORTED 双拉吃掉 pop-on-read 缓存）

v26 部署后横幅消除，但活体验证发现**弹窗列表变空**：popup 文档 ERR_ABORTED 重载使
get-data.js 被 fetch 两次（实测间隔 217ms），`initPopup` 的 `cache.pop('SetPopup1')`
是 pop-on-read —— 首拉吃掉预填条目后，二拉 pop 到空缓存 → `BGDATA.popup[0]=null` → 空列表。
且宿主未实现 VM 的 SW→扩展页广播（BroadcastChannel('bus')），popup 无二次初始化路径。

v27 修复（cs-runtime + ext-popup，**确定性方案，不赌补打时序**）：
- `refillSetPopupCache`（新导出）：重放世界 fetch get-data.js **之前**补齐并确认缓存
  （CacheLoad 验证）—— 重放 fetch 是 BGDATA 的最终消费点（主世界已钝化，原生加载吃掉
  预填条目无害），fetch 前补齐 = 本次 pop 必命中。ext-popup.ts 的 remoteSrcs 循环里
  对 `get-data.js` rel 调用，PopupOverlay 传 `anchorTab.url` 作 pageUrl。
- **Run 补报**（refill 表达式内）：宿主隔离世界实际运行这些脚本，但内容脚本的 Run 上报
  （cmd-run.js）未路由到 SW → VM 的 `badges[tabId].inject` 恒 undefined → 横幅复发
  （扩展 reload 清 storage.session 丢镜像后暴露）。以扩展页身份直发 Run（own 命令门禁：
  sender.url 以扩展根开头；msg.top=1 → setBadge 的 isTop），setBadge 同步写内存真值
  （0d2 setter → syRealInject），initPopup 读 inject=true → reset=false → 无横幅；
  VM 的 flushSession 落 `__syBadgesInject` 镜像 {1:true}，跨 SW 重启回种。
- 原计划的 60ms 密集补填（tick 循环）**弃用** —— 改为上述 fetch 前确定性补齐；
  稀疏维持（1200ms × 10）保留作端口清理与缓存保鲜。

### 5.3 验证数据（2026-11-16 晚，主库活体）

判定标准：`Matched scripts` + `searchEngineJump` 出现；扩展世界（`__syCsPop` ctx）
`.script.failed`=0、`.script.runs`>=1、无 `was restarted` 横幅。

| 场景 | total | failed | runs | banner | 备注 |
|---|---|---|---|---|---|
| 主窗 reload 后新开 | 1 | 0 | 1 | false | SW 状态：injectRead=true、mirror={1:true} |
| 开→关→再开（toggle） | 1 | 0 | 1 | false | |
| 冷 SW（CDP 杀 SW 再开） | 1 | 0 | 1 | false | 镜像回种验证通过 |
| 连续快速开关（6×700ms） | 1 | 0 | 1 | false | |

>5min 标记过期场景由机制覆盖（每次打开都重打 seenAt + Run 重报 + 镜像回种），未实跑等待。
测试库（siyuan-test-ws）已同步部署 index.js，未做运行时点验（上午报告第 4 节遗留项仍开放）。

## 6. 复盘 / 方法论## 6. 复盘 / 方法论

- **协议要对**：VM MV3 的命令是 `{cmd, data}`（`chrome.runtime.onMessage`）或
  `postMessage({id, msg:{cmd,data}})`（`sendCmdToSW`）。上一轮探针用 `{method: ...}` 全程没打中
  handler，才一直没钉死病因。
- **读源码胜过逆向**：有了 `E:\HOME\Code\violentmonkey` 源码，`initPopup` 的 `reset` 条件与
  `cache.pop` 语义一眼可见，避免了继续在 LevelDB / 毒键上打转。
- **截图会说话**：`Find scripts for this site` 可见 ⇒ `store.domain` 非空 ⇒ 上一轮
  "domain 为空、菜单被 `v-show` 藏掉"的推断是错的，直接把范围缩到 `store.scripts`。
- **内存态 vs 磁盘态**：只改 `get()` 返回值无效，VM 运行时会写回内存；必须拿住根对象。
- **SW 重启有时序窗口**：重启后宿主尚未同步 `__syLastFedTab` 时
  `tabs.query({active,currentWindow})` 返回 `[]`，验证前须轮询到活动页签就绪，否则会误判成 noninjectable。
- 未实施且非病因的并列项：manifest 注入固定 `key` 解耦路径 ID、`scr:1` 的 `__sy*` 毒键清理、
  `chrome.storage.local.set` 剥 `__sy*` 防线、`reconcileNative` 卸 session 孤儿、
  `loadData('***')` 路径错位、Chromium path→ID 算法复现。
