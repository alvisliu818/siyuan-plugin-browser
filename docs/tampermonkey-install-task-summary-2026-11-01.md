# TM 脚本安装任务总结（2026-11-01）

> 目标：在思源浏览器插件里，greasyfork 点「安装此脚本」→ Tampermonkey 真正装上并运行（走 TM 原生流程，不是宿主绕路）。
> 本文档是任务现场快照：已完成什么、卡在哪、下一步怎么走。

---

## 一、当前状态一句话

**代码修复已构建部署，但未验证**。核心谜团（TM 明明有完整镜像数据、启动逻辑也该自愈，Dashboard 却显示空列表）需要活体取证才能定位。

---

## 二、根因分析（本次会话核心突破）

### 1. TM 5.5 存储架构（反编译 background.js 实证）

```
持久后端候选（启动时倒序遍历，默认 en = "storage.local"）：
  ① storage.local  → chrome.storage.local 的 "!extdb.*" 键（值包装 {origin:"normal", value:X}）
  ② localStorage   → SW 里不可用
  ③ indexedDB      → IndexedDB("ext","general")（裸键名、裸值，无包装）
  ④ memory         → 内存缓存（运行时读写都走它）

后端选择规则（init()）：
  - 倒序先测 storage.local：supported() → 读 "!extdb.#storage" 类型标记
    - 标记缺失 → storage.local 当选（权威）
    - 标记="indexedDB" → en 翻转为 indexedDB，storage.local 被跳过
  - 当选后端 active=true；内存后端启动时经 Kt() 从权威后端回填

脚本清单读取（getUidList）：
  nn.listValues() → 同步读【内存后端】的键 → 过滤 "@uid#" 前缀
  ⇒ 内存后端没被回填 = 脚本清单永远空
```

关键常量（`I` 对象）：
- `STORAGE.EXT_DB="!extdb"`, `TYPE="#storage"`, `VERSION="#version"`, `SCHEMA="#schema"`
- `PREFIX.SCRIPT_UID="@uid#"`, `SCRIPT="@source#"`, `META="@meta#"`, `COND="@re#"`, `STORE="@st#"`

### 2. 脚本库丢失事故链（已实锤）

1. 垫片换版（shimBody hash 变化）→ 宿主 `clearStorageData(["serviceworkers"])` + `unloadExtension/loadExtension`
2. **扩展 origin 的 IndexedDB 被连带清空**（TM 脚本主库若在 IndexedDB 则全丢）
3. chrome.storage 的 `!extdb.*` 镜像幸存

### 3. 实测数据快照（_probe-extdb-state.mjs，2026-11-01）

- 镜像：**27 个 `!extdb.*` 键完好** —— 4 份脚本（SEJ + 3 测试）各有全套 `@uid#/@meta#/@re#/@source#/@st#`，另有 `#version="5.5.1"`、`#schema="6226"` 等元键
- `!extdb.#storage` 类型标记：**不存在**（⇒ 按 TM 启动逻辑应选 storage.local 并自愈）
- IndexedDB("ext","general")：**0 键**
- Dashboard（活体）：**"No script is installed"** ← 与理论矛盾的点

### 4. 未解之谜（下次验证的靶心）

理论推演：标记缺失 → TM 启动选 storage.local → Kt 回填内存 → 清单应该有脚本。
现实：Dashboard 空。可能断点：
- TM 启动时序竞态（registry 构建早于内存回填完成）
- `en` 被未知途径翻转为 indexedDB
- loadTree 响应其实有数据但 UI 渲染断（注意：宿主 bridge 日志曾见 **28KB 的 loadTree 响应**，若含脚本名则是 UI 层问题而非存储层）

---

## 三、本次代码改动（已构建部署，未验证）

### 1. 垫片 v18 → v19（src/extensions/extensionHost.ts，新增 0d 节）

TM extdb 启动守卫，双保险 + 诊断：
- **在途拦截 `chrome.storage.local.get`**：结果里 `!extdb.#storage` 若为 "indexedDB"，回调内同步改写为 "storage.local"（无竞态窗口）+ 异步落盘修正（一次性）
- **镜像 → IndexedDB 兜底回填**：镜像有 `@uid#` 条目且 IndexedDB 无任何 `@uid#` 键时，剥 `!extdb.` 前缀与 `{origin,value}` 包装写回 IndexedDB（已有脚本时不回填，防旧覆盖新）
- **启动诊断快照** `self.__syExtDbBoot`：`{ts, markerRewritten, nMirrorExt, nMirrorUid, idbKeys, backfilled, backfillErr...}`，探针可读

⇒ 效果：TM 主库锚定 chrome.storage.local（**从此免疫 clearStorageData 清库**）；即使跌落 IndexedDB 也能看见脚本。根治「改垫片必清脚本库」事故。

### 2. drain 防降级守卫（src/extensions/userscriptInjector.ts）

SW 侧注册表为空且版本号 0（未水合启动窗口/存储故障）时，宿主已有非空副本则**保留旧值**、不记录版本号，下次 dom-ready 重试拉取。治「SW eval 桥间歇失败把宿主 regs 清空 → 页面注入全静默」。

### 3. 构建部署

- `pnpm run build` 成功（dist/package.zip 360.4 KB）
- 已复制 `.src/*` → `E:\HOME\SiYuan\data\plugins\siyuan-plugin-browser\`
- 已验证部署产物含 `sy-bg-shim:v19`、`__syExtDbGuard`、`keep host copy`、`!extdb.#storage` 标记

---

## 四、下次验证清单（按序执行）

1. **启动思源**（命令见第五节），等待 ~40s 让插件加载 + v19 垫片重注入（hash 变化会触发 clearStorageData + 扩展重载 + TM SW 新 boot）
2. `_probe-extdb-state.mjs`：镜像完好性 + 读 `self.__syExtDbBoot` 诊断（markerRewritten / backfilled）
3. `_probe-dash-list.mjs`：Dashboard 是否出脚本列表
4. 若出列表 → `_probe-boot-heal.mjs` 风格验证 baidu SEJ 注入（`sej` 元素计数）
5. greasyfork 端到端：点「安装此脚本」→ 拦截合成下载事件 → TM ask/确认 → 已安装 toast → baidu 跳转栏
6. **若 Dashboard 仍空**：
   - SW 内装 loadTree spy（_probe-lt-full.mjs 方式）看响应是否含 "searchEngineJump" —— 区分存储层断 vs UI 层断
   - 读 `__syExtDbBoot` 判断守卫是否生效、TM 选了哪个后端
7. 验证通过后：按功能拆 commit + 更新 docs/tampermonkey-adaptation.md + memory 日志

---

## 五、环境备注

- 思源启动命令（必须带 CDP）：
  ```
  D:\programs\SiYuan\SiYuan.exe --port=6806 --workspace=E:\HOME\SiYuan --remote-debugging-port=9222
  ```
- TM：electronId `jajklmjmppojknefgcehkkdnibkmanoj`，扩展目录 `E:\HOME\SiYuan\data\storage\petal\siyuan-plugin-browser\extensions\edge-iikmkjmpaadaobahmlepeloendndfphd-srogo8`
- 探针目录 `E:\HOME\Code\_probe-*.mjs`；本次新增：`extdb-state`（存储全景）、`boot-heal`（SW 重启自愈验证）、`dash-reopen`、`host-state`、`webview-list`
- 网络前提：greasyfork/update.greasyfork.org 需系统代理（clash 127.0.0.1:7897）开启，SW fetch 随系统代理走
- 垫片迭代铁律（v19 后仍适用）：改 shimBody 必触发 clearStorageData —— 迭代后必跑 extdb-state 探针确认脚本库幸存

## 六、遗留问题（与本任务相关，未修）

- **思源进程启动后 1~2 分钟自动退出之谜**：本次会话反复出现（无 WER 崩溃事件、无锁文件、日志无异常），可能与强杀进程后状态有关，也可能有外部因素；下次启动时留意
- 宿主确认弹窗 9s 回落链路与 TM ask.html 双通道并存，安装去重逻辑（3 分钟同脚本防重弹）已有，未回归验证
- 「设置发生错误,本条例将会被移出设置」原生 confirm：各源码均无此文案，疑似 TM wipe 检测对话框（反编译见到 "Tampermonkey detected inconsistencies..." 文案），未深挖
