# Tampermonkey（油猴）适配 — 状态与未完成任务

> 更新：2026-10-30 晚（P0/P1/P2 全部关闭，剩 P3 提交 + .tmp-deploy 清理）。本文档是油猴适配开发的中断现场记录，恢复开发前先通读。
> 上下文：目标是让真 Tampermonkey 扩展（Edge 商店版 5.5.1）在本插件自建浏览器里完整工作
> （面板、脚本注入、GM API），适配扩展本身而非自建脚本引擎。

## 一、当前总体状态

| 链路 | 状态 | 说明 |
|---|---|---|
| SW handlers（消息路由前提） | ✅ 已修复 | 垫片注入循环静默失败导致 TM 三周无垫片（commit 29734fc） |
| 面板（popup / action.html） | ✅ 可用 | 工具栏油猴图标点击弹出，UI 完整渲染 |
| userScripts 注册表 | ✅ 已通 | TM 真的在用垫片补的 chrome.userScripts 注册引导包（page.js + content.js，v2） |
| 宿主 drain 对账 | ✅ 已通 | usInjector.stats 显示 2 scripts @ v2 |
| 页面脚本注入 | ✅ 已通 | example.com / bidianer.com dom-ready 注入成功（console 有 `userScript "..." injected`） |
| **Dashboard（options.html 整页）** | ✅ **已修复** | P0 启动竞态根因定位 + 三重修复（见二.8）；`_probe-bypass` 确认走垫片路径（落地 about:blank + iso 世界 fakeLoc/confirm 换装、bodyLen 266712、dialogs=0），`_probe-verify` 确认渲染完整（"Tampermonkey® v5.5.1 Installed Userscripts…"）；此前遗留的坏页签热重载后走干净恢复路径自愈 |
| i18n 占位符（P1） | ✅ 已验证 | head 文本 "Tampermonkey® by Jan Biniok"、版本号正常，`$name$` 原文漏出问题关闭 |
| 真实用户脚本实测（P2） | ✅ **已闭环** | SY-GM-Test（@match example.com + GM_setValue/getValue/xmlhttpRequest）：真实 UI 编辑器新建→保存→注册→注入→执行→`GMTEST:{"setValue":"ok","getValue":"v1-…","xhr":"ok:200:577"}`。期间发现并修复**端口回包滞留**根因（见二.9） |
| 提交 | ⬜ 未做 | 全部改动在工作区（见三 P3） |

## 二、已完成的修复（已构建部署到主库；除 1-2 外均在工作区未提交）

1. **垫片注入循环静默失败**（29734fc 已提交）：`injectBackgroundShims` 的 catch 改为带扩展名 warn + 500ms 重试；`installFromPath` 在 loadExtension 前先注入垫片。根因：TM 的 background.js（614KB）自 10-09 起三周没注入成功，catch 吞错无人知晓。
2. **syncUserAgent 构造期守卫**（29734fc 已提交）：webview 未 attach 时 getUserAgent/setUserAgent 抛错；UA 伪装下沉到 `webRequest.onBeforeSendHeaders`（`uaForRequest`）。
3. **chrome-extension:// 整页打开被 Electron 拒绝**（工作区）：webview loadURL 该协议必然失败退 about:blank → `injectExtensionPageRuntime` 加 `rebuildDom` 路径（从磁盘读 html 重建 body/标题/全局样式再重放脚本）；`maybeInjectExtensionPage` 探页面实际 DOM 空即走重建。
4. **健康监测防误判**（工作区）：注入期间 `extPageInjecting` 挂起监测；垫片页（当前 URL 为 chrome-extension://）直接跳过自动 rebuild——rebuild 对"加载被拒"毫无意义，只会把渲染好的页面洗成空白。
5. **垫片统一消息归一 `__syNormalizeMsg`**（工作区）：TM loadTree 缺 `referrer` → SW 侧 `pd.level(undefined)` 抛 `undefined.replace` → options 引导走 fail → 原生 confirm 阻塞。三条路由（CS→SW sendMessage / port 派发 / storage onChanged 回程）都在派发点调用垫片函数（逻辑只住垫片一处，宿主只透传）。
6. **PRELUDE confirm/alert/prompt 抑制 + `__syErrors` 收集器**（工作区）：扩展世界静默吞原生对话框并记录参数/异常栈。
7. **i18n named placeholders**（工作区，已验证）：`getMessage` 支持 `$name$` → `placeholders[name].content`（`$1` 引用或常量），两处垫片同步（cs-runtime 页面世界 + extensionHost SW）。
8. **P0 启动竞态三重修复**（工作区，本会话）——**根因链（第四根因）**：SiYuan 启动恢复页签早于 `extensionHost.load()` 完成 → `WebviewController.isManagedExtPage` 因 `list()` 为空返回 false → chrome-extension:// 导航放行 → webview 未 attach 时 `loadURL` 抛异常，回退 **src 直赋** → Electron 原生加载扩展页 → preload 在扩展页不生效（实测主世界 `confirm` 为 native）→ SW 冷启动致 TM 引导 fail → 裸原生 confirm 同步阻塞渲染线程（用户现场 4 叠框假死）。修复三处：
   - `WebviewController.ts` `isManagedExtPage`：宿主未就绪（无 host / `!host.isLoaded()` / list 空）时**保守拦截全部 chrome-extension://**，catch 也返回 true。本 webview partition 的扩展全部由本插件装入，不存在第三方 chrome-extension://，误拦代价只是垫片未就绪时短暂空白，可接受；
   - `extensionHost.ts` 新增 `isLoaded()`（约 :995-999）供上判断；
   - `WebviewController.ts` `did-navigate` **漏网回收**：无论哪条路径（src 直赋 / 未拦截导航）让 guest 真落地 chrome-extension://，立即 `loadURL` 改道走垫片路径，不给主世界扩展脚本跑引导的机会（原生 confirm 无 hook 会同步阻塞整页）。
9. **端口常驻泵（P2 中发现，P2 闭环的最后一块）**（工作区）——**根因**：GM_xmlhttpRequest 是 port 通道（脚本世界 `port.postMessage` → SW `onConnect` 端口处理器 → 回包写 `__syPortOutbox`），而 `routePortMessage` 只在发送时捎带一轮 outbox 拉取且**取到首批即返回**（ack 到得快）——真实 HTTP 响应晚数百 ms 到达后无人再取，永久滞留 outbox；onerror/ontimeout 同走 outbox 全部饿死。表现为脚本里 xhr 无回调无报错（SW 侧实际已 fetch 成功，数据躺在 outbox 里）。修复：世界侧 connect 注册开放端口 + 单一常驻泵（600ms `hostCall("portpoll")` 统一拉取所有端口 outbox 并派发，busy 标志防冷启动求值堆积，无端口自动停摆）；宿主 `cs-runtime.ts` 新增 `portPoll()`（单次 eval splice 原子排空，与 routePortMessage 竞争不重复投递）。SW 侧 background.js 不用动（`__syPortOutbox` 垫片已有）。同机制顺带解决了 values/tabInfo 端口回包积压。

## 三、未完成任务（按优先级）

### ~~P2：真实用户脚本全链路实测~~（已完成，见一/二.9）

实测脚本 SY-GM-Test 已留在 TM 里（Dashboard 可见）。驱动手段沉淀：
- 宿主主窗口 eval `window.browserPlugin.openUrl("<url>")` 开任意 URL 页签。
- TM 编辑器 = **CodeMirror 5 textarea 模式**，CM 实例住在 iso 世界（expando 世界隔离，主世界拿不到）：iso 世界 `document.querySelector(".CodeMirror").CodeMirror.setValue(text)`；保存走菜单 File→Save（Save 按钮不在 DOM）；新建脚本视图 `location.hash = "#nav=new-user-script"`（hash 写穿透真 URL）。
- GM 函数（GM_*）是**闭包变量不是全局**，iso 世界 `typeof GM_xmlhttpRequest` 探不到；结果回读用 `document.title`（DOM 跨世界共享）。

### P3：提交（按功能拆 commit）

工作区未提交（15 文件 +1431/-201 + 未跟踪 `src/extensions/userscriptInjector.ts`，再加二.3-9）：
- feat(uscripts): userscriptInjector + 垫片 v16-v18（userScripts 适配/tabs.query 归一/顶层水合）+ cs-runtime 配套
- feat(browser): chrome-extension:// 整页 rebuildDom + 健康监测豁免 + WebviewController loadURL 改道
- fix(ext): BrowserTab senderPageUrl / ext-popup spoofLocationUrl+base / preload 主世界抑制 / cs-runtime+extensionHost false 回包语义 / __syNormalizeMsg 消息归一 / PRELUDE 对话框抑制 / i18n named placeholders
- fix(ext): 端口常驻泵（GM_xmlhttpRequest 回包滞留，cs-runtime portPoll + 世界侧泵）
- fix(browser): P0 启动竞态保守拦截（isManagedExtPage + extensionHost.isLoaded + did-navigate 漏网回收）
- （29734fc 已提交的不动）

### ~~P4：loadTree `referrer` 缺失上游源头~~（已结案，11-01，结论：不存在运行时变量，无需通用兜底）

浏览器实证（活页面世界包装 `chrome.runtime.sendMessage`/`connect.postMessage` 抓发送栈 + SW 全量消息 spy）：
- **extension.js 全部 22 处 referrer 均为硬编码字面量**：dashboard 引导 `te({referrer:"options"})`、脚本/回收站 `oe()` 用 "options.scripts"/"options.trash"、tab 配置 "options.scripts.userscripts*"、popup `window.main()` 用 "actions"、editor 路径由字面量拼接（`.storage`/`.treeid`）。editor.js 无 loadTree。真 Chrome 恒有值 = 字面量恒有值。
- 实测 boot/popup/hash 切换全流程 **0 例缺 referrer**（sendMessage 与 port 双通道 spy 均空——loadTree 走 sendMessage，port spy 落空的原因是端口复用绕过新 wrapper）。
- **P0 结论修正**：options 页 "An internal error occurred" confirm 的真实触发条件是 `te()` 回调收到**空响应**（`(e=e||{}).items || (e.error ? … : confirm(…))`）——即 SW 冷启动/桥未就绪时请求无响应，与请求 referrer 无关；`pd.level(undefined)` 只在手动构造的无 referrer 探针消息里复现。当时 normalize 与重试窗口同时落地，真正解卡的是后者；normalize 是无害保险。
- **评估**：不需要更通用的消息兜底——真实发送方全是字面量，通用兜底永不命中，只会掩盖真链路 bug。现有 loadTree 专属 normalize（origin 回退）保留即可。可选观测项（未做）：normalize 命中时打 warn，需垫片 v18→v19 全量重注，收益低。

## 四、部署/仓库状态

- 磁盘部署 `E:\HOME\SiYuan\data\plugins\siyuan-plugin-browser\index.js` = 最新构建（含以上全部修复，含 P0 三重修复），主库插件已热重载生效。
- `dist/`（.src/）构建产物与源码同步；`preload.js` 直接拷 `src/preload.js`。
- TM 扩展目录 `E:\HOME\SiYuan\data\storage\petal\siyuan-plugin-browser\extensions\edge-iikmkjmpaadaobahmlepeloendndfphd-srogo8\`：background.js 已带 v18 垫片（勿手工改，换垫片版本会自动剥离重注）。
- 身份速查：TM electronId = `jajklmjmppojknefgcehkkdnibkmanoj`（native:true 已持久化）；SiYuan Clip = `domojehgaedkbefcnpeokphemdcbkaog`；CDP 端口 9222；宿主页 target URL = `https://127.0.0.1:50779/stage/build/app/`（探针匹配用 `/stage\/build\/app/i`）。
- git：HEAD = 29734fc（本会话前段修复）；油猴 WIP 全部在工作区。git 分离布局：`git --git-dir=E:\HOME\Code\siyuan-plugin-browser-git --work-tree=E:\HOME\Code\siyuan\siyuan-plugin-browser`。

## 五、调试工具（E:\HOME\Code\_probe-*.mjs，临时文件，不入库，恢复调试直接复用）

| 文件 | 用途 |
|---|---|
| `_probe-health.mjs` | 主窗口健康检查：插件状态、扩展集、SW 状态、usInjector stats（恢复现场第一步） |
| `_probe-bypass.mjs` | 导航绕过取证：全目标列表 + webview 各世界状态 + 宿主 extensionHost 现状 |
| `_probe-repro.mjs` | 复现绕过：宿主 extensionHost 状态 + 直调 openUrl + 抓 [browser-plugin] console 日志 |
| `_probe-mainworld.mjs` | 验证主世界是否跑过 TM 代码（原生加载成功的铁证） |
| `_probe-autopsy.mjs` | 尸检：枚举 options.html webview 所有执行世界，逐个读 hook/`__syBlockedDialogs`/`__syErrors` |
| `_probe-iso-deep.mjs` | 深查隔离世界里 TM 跑到哪一步 + 主窗口截图 |
| `_probe-verify.mjs` | 验证 location 伪装后 UI 渲染（body 大小/TM 标志物/ISO 世界状态） |
| `_probe-sw.mjs` | 查 TM SW：`__syOnMessageHandlers` 是否注册、loadTree 直调是否可用 |
| `_probe-loadtree2.mjs` | 在 ISO 世界直发 loadTree，取真实回包 |
| `_probe-loadstack.mjs` | SW 里手动派发 loadTree（带 referrer/filter，已带完整 sender）抓异常栈 |
| `_probe-coldstart.mjs` | 关旧页签→重开→抓主窗口 console 35s 时序 |
| `_probe-dashstate.mjs` | 探 Dashboard 页 DOM/响应性（8s 超时即线程阻塞） |
| `_probe-dashexc.mjs` | 重开 Dashboard 并即时订阅异常/console，抓 TM 内部错误细节 |
| `_probe-dasherr.mjs` | 连 options 页订阅异常 + reload 重触发，抓 TM 内部错误栈 |
| `_probe-dashload.mjs` | 订阅主窗口 console + 再开 Dashboard + 抓 loadURL/错误日志 |
| `_probe-timeline.mjs` | openUrl 后观察时序日志（内置日志即调用点证据） |
| `_probe-blank.mjs` | 检查 about:blank webview 实际 DOM（区分真空白 vs 已重建的 TM 内容） |
| `_probe-whitediag.mjs` | 白屏诊断：DOM 是否还在、关键节点计算样式、CSS 块状态 |
| `_probe-hostwv.mjs` | 宿主侧 webview 元素尺寸/页签状态/截图前 DOM 状态 |
| `_probe-analyze.mjs` | 从磁盘分析 options.html 结构（body 捕获长度等） |
| `_probe-reload-tab.mjs` | 重载 Dashboard 页签：先关再开（走 openUrl 完整路径），等 25s 后验证数据区 |
| `_probe-reload.mjs` | 热重载插件（location.reload 主窗口） |
| `_probe-shot.mjs <urlRegex> <out.png>` | 截图任意 webview target |
| `_probe-blockedstate.mjs` | pause 时读 `__syBlockedDialogs`/`__syErrors`（验 confirm hook 是否生效） |
| `_probe-loopstack.mjs` | 重开 Dashboard + 轮询 target + Debugger.pause 抓栈 |
| `_probe-multistack.mjs` | 连续 4 次 pause 采样判定死循环 vs 长任务 |
| `_probe-pause.mjs` | 单次抓栈 |
| `_probe-p2-*.mjs`（open/edit/diag/save/save2/menu/run/xhr/xhrdebug/retry/perm/drops/portspy/final） | P2 全链路实测系列：开 Dashboard→编辑器注入（CM5 iso 世界 setValue）→File 菜单保存→开 example.com→GM 结果回读；`portspy` 是端口滞留取证关键（CONNECT/RESP + `__syPortOutbox` 滞留 dump） |
| `C:\Users\alvisliu\.workbuddy\skills\siyuan-plugin-debug\scripts\cdp.mjs` | 通用 CDP 探针（evalFile/eval/shot，`--win N` 选窗口；SW target 需直连 ws，见各探针写法） |
| `/tmp/wake-tm.js`（经 cdp.mjs evalFile 用） | `host.wakeSw("jajklmjmppojknefgcehkkdnibkmanoj")` 唤醒 SW |

## 六、关键知识（踩坑记录）

- **Electron 44 webview 加载 `chrome-extension://` 被拒**（退 about:blank）——扩展整页必须走"磁盘读 HTML 重建 DOM"路径，原生加载假设不成立。
- **preload 在扩展页不生效**（实测原生加载的扩展页主世界 `confirm` 为 native）——这就是启动竞态下会弹裸 confirm 的直接前提；扩展整页一律走垫片重建路径，保守拦截是唯一可靠防线。
- **webview 未 attach 时 loadURL 抛异常 → 回退 src 直赋**——src 直赋绕过导航事件链，拦截不到，必须靠 did-navigate 漏网回收兜底（P0 第三处修复）。
- **原生 confirm/alert 在 Electron 是同步阻塞对话框**（标题=主窗口标题"SiYuan"）——扩展 JS 任何 `confirm` 都会假死页面，垫片必须吞掉。清残留对话框：Win32 `FindWindowW('#32770','SiYuan')` + `PostMessageW 0x0010`（每次新 shell 会话需重新 Add-Type）。
- **同页面所有 JS 世界共享主线程**：扩展世界死循环/阻塞会卡死一切 CDP evaluate（含主世界）。
- **webview 分区**是 `persist:siyuan-browser`；扩展注册/SW 都在这（不是 persist:webview）。
- **SW 懒启动**：loadExtension 后不自动跑，唤醒用 `ses.serviceWorkers.startWorkerForScope("chrome-extension://<id>/")`（host.wakeSw 已封装）。
- **TM loadTree 炸点**：background.js:1350 `level: e=>e.replace(/\.$/,"").split(".").length`，消息缺 `referrer` 即炸；`__syNormalizeMsg` 兜底后正常。
- **popup 世界 `chrome.tabs.create` 是静默桩**（cs-runtime.ts:2260 stubFor apply=PROMISE_UNDEF），SW 侧 tabs.create 假 tab 不开页签（extensionHost.ts:511）——TM"在新页签打开"类动作不开新页签，已知限制。
- **GM_xmlhttpRequest 走 port 通道**（脚本世界 `port.postMessage` → SW onConnect → `__syPortOutbox` 回包），不是 sendMessage——在 onMessage spy 里永远看不到 xhr 消息；SW 侧 fetch 其实一直成功，卡的是宿主回包泵（二.9）。
- **TM 扩展世界的 expando 隔离**：iso 世界 JS 挂在 DOM 节点上的属性（如 `.CodeMirror` 的 CM 实例）主世界读不到，必须用 CDP iso context eval；反向 DOM 操作（点击/聚焦）两边都行（事件全世界广播）。
- **TM 编辑器 = CodeMirror 5 textarea 模式**：外部注入内容走 iso 世界 `cm.setValue()`；直改 textarea.value + input 事件 CM 不吃。新建脚本入口是 `location.hash = "#nav=new-user-script"`，保存入口是菜单 File→Save。
- **Dashboard 的 "Host permissions denied by user" 提示**：点 Grant All 可消（写 TM 内部权限状态）；实测 GM_xmlhttpRequest 的卡点在回包泵而非权限（SW 预先就在 fetch）。
- **Worker lint.js SecurityError**——TM 脚本编辑器的语法检查在 Worker 里跑被拒，已知限制，不阻塞编辑保存。
- 垫片升级必做：改 shimBody 后靠 changedShimCount 触发 unloadExtension 全部 + clearStorageData(serviceworkers) + reconcileNative——SW 从旧脚本缓存恢复是历史坑（v12/v13 教训）。
- 工具坑：Grep 工具对本仓（siyuan-plugin-browser 源码树）部分场景失效，用 PowerShell `Select-String` 兜底；沙箱 job 会杀 SiYuan 进程，须 WMI `Win32_Process.Create` 拉起（`--remote-debugging-port=9222`）。

## 七、下一会话指引

1. 剩余：清 `E:\HOME\Code\.tmp-deploy`（若复现），`_probe-sej-*.mjs` 留作回归探针。
2. 真实脚本回归：Dashboard 里 SY-GM-Test / searchEngineJump(27752) 可作回归样本（见下「SEJ 安装实战」）。

## 八、SEJ 安装实战（10-31/11-01，真实 greasyfork 脚本 27752）

**结论：安装+执行+UI 渲染全链路打通**（百度搜索页 133 个 sej 元素，`A.sej-engine sej-drop-list-trigger` 跳转栏完整）。

- **TM 在线安装（Utilities URL 导入）在本环境不可用**：SW 内 `fetch("greasyfork.org")` 直接 "Failed to fetch"（系统代理 ProxyEnable=0，直连被重置；上次会话能走到 ask.html 是因为当时代理开着）。Node 直连同样失败，走代理 127.0.0.1:7897 可达。
- **替代安装路径（已验证）**：代理下载 .user.js 源码 → TM 编辑器直装（`#nav=new-user-script` → iso 世界 `cm.setValue` → File 菜单 Save）。存储落盘 5 个 key（@meta/@re/@source/@st/@uid）。
- **@require 缺失非致命**：toGBK.js 下载超时（网络），每页加载有 warning 但脚本照常执行；百度 GBK 相关功能可能受影响。
- **注册表形态澄清**：`__syUserScriptsReg` 只有 2 个引导条目（page.js/content.js）是**正常形态**——真实用户脚本不走 userScripts 逐条注册，走 content.js 引导的 `prepare` 消息通道由 TM 自己分发。
- **注入时机坑**：宿主恢复页签的 dom-ready 早于 extensionHost.load() → `injectNativeUserScripts` 因 `!this.loaded` 静默跳过且**不重试**（P0 启动竞态的注入版）；恢复的页签要手动 reload 才注入。另：`void injectForPage()` 的 rejection 被 void 吞，`drain` 抛错无日志——排障时先宿主手动调 `usInjector.injectForPage(webviewEl, url)` 复现。
- **注入日志在宿主 console**（`[browser-plugin] userScript "..." injected @ url`），不在 webview target——探针别听错地方。
- **bing 特有问题（站点侧，非适配层）**：cn.bing.com 每次导航后很快弹 `/identity/idtokenv2`（整页替换，脚本栏被冲掉）；SEJ 在 bing 上执行正常（console 实证）。验证 UI 用百度（无重定向）。
- SW 侧 fetch 失败的产品级思路（未做）：fetch 失败时兜底走 kernelfetch（内核 forwardProxy 已验证可达 greasyfork——Edge CRX 兜底同款）。

## 九、Violentmonkey 适配（2026-11-01，垫片 v20/v21）

用户移除 TM 改用 Violentmonkey 2.50（Edge 商店版，目录 edge-eeagobfjdenkkddmbclomhiblgggliao-19f6031，electronId lohncnmkmfabdgoifacpkahlnnlhiiai）。症状：popup 点设置/加号无反应，目标页 `extension://<id>/options/index.html` 打不开（该 URL 是 Edge 里的地址形态；本环境是 chrome-extension://）。

**根因（诊断副本法实证，两层串联）**：

1. **chrome.extension.isAllowedIncognitoAccess 缺失**（v20/0e 修）：VM sw.js 顶层 probe 该方法，Electron 的 chrome.extension 命名空间存在但缺它 → 顶层 TypeError → SW 启动即死（Preferences 里 has_started_service_worker 恒 false；主进程日志 "Service worker registration failed. Status code: 15"）→ popup 的 OpenDashboard/OpenEditor 消息全部路由到死 SW。
2. **chrome.notifications 等命名空间求值期整体缺失**（v21/0f 修）：第 1 节通用壳只有 5 个泛型事件（onChanged/onClicked/onCommand/onInstalled/onStartup），VM 顶层用 browser.notifications.onClosed.addListener → TypeError（SW 启动即死第二幕）。0f 按命名空间补完整事件面（缺失则建壳；已存在则只补缺失事件）。

**调试方法论（本次沉淀）**：

- **诊断副本法**：拷扩展目录 → sw.js 整体包 try/catch（错误落 chrome.storage.local "!sySwErr"）→ 以新目录 loadExtension（**新路径→新 id→新注册**，同路径重载会吃旧脚本缓存——本次最大的弯路）→ startWorkerForScope → CDP 连 SW 读错误。零假阳性，一击必中。
- **Worker 模拟法不可靠**：stub 忠实度永远差一截（缺 session/缺事件面/缺 getManifest 字段全是假阳性），只适合粗筛，定案必须真实 SW。
- **Electron SW 环境事实**：options_ui 字典形态在 getManifest 里保真（字符串形态被丢）；chrome.storage.session 存在；tabs.create 原生是空转桩（resolve 假 tab），垫片 5a 出箱桩因原生存在而不装——VM 走出箱是因为 `if (!chrome.tabs.create)` 条件在其 SW 里成立（原生未暴露 create）。
- **修复验证链**：SW 起 → handlers 注册（__syOnMessageHandlers 非空）→ 直调 handler({cmd:"OpenDashboard"/"OpenEditor"}) → 出箱含 options URL（含 #scripts/_new/<id> hash）→ 排空 openUrl → 浏览器页签 + webview 加载 options 页 → VM UI 完整渲染（Settings/Backup/Recycle Bin/New/Install from GreasyFork 全在）。
- **换版注意**：v21 改 shimBody → changedShimCount 触发全扩展 unload + clearStorageData(serviceworkers) + 重载（老流程）。VM 的 userscript 存储在扩展自己的 storage（chrome.storage.local），与 TM 的 !extdb 机制无关，clear 不伤。
