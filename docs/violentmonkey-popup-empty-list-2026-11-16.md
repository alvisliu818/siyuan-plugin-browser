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

## 5. 已知副作用（未消除）

弹窗会多出一行 `Violentmonkey was restarted. Please reload the tab to run userscripts.` 与
`Reload tab`，顶部总开关显示关闭态。原因：`popup-tracker.js` 在
`reset && 补算出的 scripts 非空` 时判定为"SW 重启后内容脚本仍连着"，置
`failure = [failureReasonRestarted, IS_APPLIED]` 并把 `injectInto = 'off'`。
**脚本列表不受影响**，但状态展示有误导。

彻底消除需要换成「保留 `badge.inject` 为真 + 由宿主在 popup 打开前模拟一条 `SetPopup`
填 VM 内存 cache」的方案（`reset=false` 即不触发该分支）。该方案需拦截 SW 的
`self.onmessage` 或 `webRequest.onBeforeRequest`，并处理 `augmentSetPopup` 的异步竞态，
复杂度明显高于本次收益，故留作下一步。

## 6. 复盘 / 方法论

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
