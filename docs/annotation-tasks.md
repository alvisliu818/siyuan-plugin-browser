# 网页标注功能 — 任务状态与未完成事项（2026-11-17 更新）

## 2026-11-17 v0.3.13 推送部署（无新功能，状态同步）

- 3 提交 push origin/main：2410f91（标注气泡被 popover UA 样式居中带偏 + 新建标注点击无浮窗）、1590cc2（标注链路四修：建文档 listDocTree/批注内联补建/右键菜单标注/跳转兜底加固）、2181c8c（本档案入库）。
- 上一轮部署（21:49）早于最后提交（21:59）→ `CI=true yarn build` 重建（**仓库已 packageManager=yarn，旧文案 pnpm run build 会被拒**）→ dist/package.zip（平铺 12 文件）unzip 覆盖主库+测试库，0.3.13 双库一致；内核未运行，下次启动生效。
- 仍未打 tag/未建 GitHub Release（tag 0.2.0 与 plugin.json 0.3.13 脱节，既有状态）。

## 2026-11-16 v0.3.9：悬浮弹窗批注就地简单编辑 + 拖动不消失（已实机验证 10/10）

- **弹窗简单编辑**：批注文本点击进入 textarea（Ctrl+Enter 保存 / Esc 取消），经 saveNote 通道写回思源批注块；noteSaved 回包回显，页内内联小字同步（__syAnnSetNotes）。新结构嵌套列表项 updateBlock 用 "- 文本"；空批注恢复占位 "- "；旧结构页面级锚点段 fetchAnnotations 懒补 noteId=row.id。清空批注=恢复占位块。段内换行 → "  \n"（kramdown 硬换行保持单块）
- **拖动不消失（根因）**：原生 -webkit-app-region 拖拽期间页面收不到鼠标事件，body mouseleave 误触 800ms 收起计时 → 弃用，改 pointer capture 手动拖动经 chan move → host setPosition；缩放手柄同改。**关键坑：子窗 rAF 会饿死**（合成帧不产生时永不触发，聚焦也没用）→ rAF 合帧加 50ms setTimeout 兑底 flush（真实用户拖动时合成帧活跃不受影响，纯加固）
- **探针**：verify-float-edit.mjs 10/10（hover 弹出/拖动中与拖完不消失/位移生效/编辑器/写回 type=i/回显/内联同步/编辑中不收起/非交互自动收起）。经验：① Electron 子窗无法注入真实鼠标 down/up（sendInputEvent 与 CDP Input 均丢弃，move 反而能进）→ 用合成 PointerEvent 链（screenX 用固定基准）+ DOM click()；② updateBlock 后 SQL 可见滞后 ~2-3s（内核索引），断言要轮询；③ blocks 表列表项=容器(NodeListItem)+内段落(NodeParagraph)两行镜像同一内容，非重复块；④ 分离仓 config 带 core.bare=true+worktree 组合，git -C 会报 invalid config，必须走 gl.sh（--git-dir+--work-tree）
- 测试库实例重启验证用 schtasks 一次性任务（sy-test-siyuan，已用后删除）；主库 E:\HOME\SiYuan 已部署 0.3.9（未运行，下次启动生效）；本地提交未 push

## 历史状态（2026-11-16 早前）

## 已完成并验证

- 标注全链路：选中文字 → 悬浮气泡「标注」/ 地址栏 ✎ 菜单 → 思源标注文档落库
- 文档结构（大纲式，最终形态）：`- [选中文字](url#syann=<annId>)` 列表项锚点 + 嵌套子项批注（custom-syann 挂列表项，noteId 指向子项）
- 页面级标注（无选区）：`- [页面标题](url) - 时间` 列表项 + 子项
- 高亮恢复（锚点 quote+前后文定位）、点击高亮 → 弹窗、`#syann=` 链接跳转自动滚动定位
- 重复文本消歧（prefix/suffix）、懒加载补画、占位清空（updateBlock 需 `- ` 列表语法）
- 显示问题根因修复：BannerPlugin 污染 index.css（test /\.js$/）
- insertBlock 返回事务对象解析（doOperations[0].id）、ial 转义（含 &#123;）
- **弹窗形态 = 方案 A（思源原生独立窗口）**，已实机验证全链路：
  - 点击高亮 → `openWindow({doc:{id:noteId},width:560,height:480,position,alwaysOnTop:true})` 打开原生 protyle 窗口，聚焦批注块（块级聚焦，带「退出聚焦」面包屑）
  - 窗内直接书写 → 原生 protyle 自动保存回思源块（SQL 查证 content 已更新）
  - 验证脚本：E:\HOME\Local\sy-debug\verify-annwin.mjs / verify-anntype.mjs / close-annwins.mjs
- 以上均已在测试库实机验证通过；测试库有测试页服务（127.0.0.1:18765，schtasks 任务 sy-test-server）

## 未完成任务（按优先级）

### 1. 清理项

- [x] annotation-popup.html（OS 子窗方案遗留）已从 src/assets 与 webpack CopyPlugin 删除；测试库部署目录里的旧文件也已清除
- [x] 方案 B（Dialog+textarea）代码、editorWindows Map、跨窗口桥（sy-ann-bridge）已随方案 A 落地一并删除
- [ ] 测试库遗留两条旧结构标注（example.com / 127.0.0.1 测试页 doc 内 b+p 结构），兼容读取已实现，如需迁移为新列表结构未做
- [ ] 测试探针脚本堆积在 E:\HOME\Local\sy-debug（诊断用，可留）

### 2. 发布与部署

- [x] 测试库（E:\HOME\Local\siyuan-test-ws）已部署 build18（含方案 A），实机验证通过
- [x] 主工作空间（E:\HOME\SiYuan）已部署 0.3.0（主库当时未运行，下次启动生效）
- [x] 推送：版本升 0.3.0 → 重建 → 两个提交（build(pnp) 路径迁移 cdb288c + feat(browser) 标注功能 2fc1c02）→ push origin/main 已同步。**未打 tag/未建 GitHub Release**（用户选择 commit+push+部署;gh CLI 不可用）
- [ ] 如需上架集市：补打 tag 0.3.0 + GitHub Release 上传 dist/package.zip（gh 缺失，需手动或 API）
- 私有开发文档 docs/annotation-tasks.md 不入公开仓（含本地路径/调试笔记），提交时已排除

## 关键技术备忘

- **openWindow 运行时可用但 npm 类型缺失**：siyuan npm 包（1.2.2）的 d.ts 未声明 openWindow，但运行时 API 对象已含（思源 3.1+，3.8.10 实测有）。annotation.ts 顶部用 `declare module "siyuan"` 模块 augmentation 补声明后正常 import 调用。底层 openNewWindowById：传块 id → getBlockInfo → 独立 OS 窗口 + 原生 protyle，action=cb-get-all（块级聚焦）
- **构建体系已迁移 Yarn 4 PnP**（2026-11 从 pnpm 迁，.yarnrc.yml nodeLinker:pnp，全局 cache E:/HOME/Runtime/.yarn-global）。构建用 `CI=true yarn build`（不再是 pnpm）；无 node_modules，类型经 PnP 解析。项目存在大量既有 tsc 报错（dnrEngine/ext-popup/cs-runtime 等），webpack 用 esbuild 不做类型检查，annotation.ts 本身无类型错误
- insertBlock 返回事务对象数组：取 `data[0].doOperations[0].id`
- 列表项更新必须列表语法：updateBlock data = `- 文本`（纯文本报 invalid block structure）
- 两级列表 markdown 一次插入 + 从 ops[0].data 的 DOM 按 data-type 解析各层级块 id（防查询竞态）
- ial 转义含 &#123;/&#125;，解析需还原花括号
- 旧页签跑旧 guest 脚本：页内脚本随导航注入，调试时先 F5
- 站点 meta CSP 会禁页内 <style>/style 属性 → 样式必须走宿主 insertCSS
- 测试库实例必须 schtasks 拉起才常驻（agent 沙盒命令结束回收进程树）
- **main.js 调试补丁保留**：D:\programs\SiYuan\resources\app\electron-dist\main.js 含环境变量门控补丁（`if(process.env.SY_REMOTE_DEBUG_PORT)`），正常启动 inert，跨会话 CDP 调试依赖它，未还原（如需还原删除该 if 块即可）
- 插件源码不受 git 跟踪（monorepo .gitignore 忽略）；改动前备份在 C:\Users\alvisliu\.qoder\tmp\annotation.ts.bak-planB
## 2026-11-18 v0.3.13 后：取消高亮/取消小字 + 悬浮弹窗开关（b8b26f2 + 27210a3）

- **选区气泡新增「取消高亮」「取消小字」**：用户拍板语义=页内显示层面取消，**标注文档与块不删**。状态持久化在锚点 custom-syann 新增 `hl`/`inline` 布尔字段（缺省视为 true 兼容旧数据），fetchAnnotations 带回 hlOff/inlineOff，页内 wrapOne 跳过包裹/小字。**关键坑：applyMeta 与 showDialog 懒补 noteId 都会整体重写 custom-syann，必须带上 hl/inline，否则改色/改标签会静默重置已取消的显示。**
- 命中优先级：选区与高亮相交（range.intersectsNode）带 id > quote+前后文精确匹配 > quote 唯一匹配；多条同文不猜，提示点对应高亮。
- **设置新增两项**：showAnnRemove（气泡取消按钮显隐，页内经 __syAnnSetRemoveVisible 回刷）、showAnnFloat（悬停/点击高亮弹悬浮窗总开关，关闭后悬停静默、点击一次性 toast）。
- **悬浮弹窗自收起修复**：原设计 mouseenter 置 hovered 但**弹窗显示在光标下时边界事件不触发** → hovered 恒 false → 800ms 后自收（=「移上去还关」）；修法=计时器到期实测 body.matches(":hover") 续期 + pointermove 兜底同步 hovered。
- **固定后仍自关 bug 双保险**：宿主侧 floatWins 记 __syPinned，hide 消息对已固定窗口直接忽略；openFloat 重入不再对已固定窗口下发 autohide（防 hover 重触发改回自动收起）。
- 轮询消费：WebviewController 注入轮询对象加 `window.__syAnnRemove`，BrowserTab onAnnRemove → annotation.setDisplayOff。
