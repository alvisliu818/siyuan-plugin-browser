# 思源浏览器插件

基于 [思源笔记](https://b3log.org/siyuan) 插件系统的内置浏览器，使用 Electron `<webview>` 标签实现，支持多页签、书签、历史、下载。

> ⚠️ 仅桌面端（Electron）可用。移动端与浏览器访问端不可用，因为 `<webview>` 标签是 Electron 专有能力。

## 功能特性

- **多页签浏览**：每个浏览器页签是思源原生自定义页签，可拖拽、拆分窗口、关闭
- **完整 Chromium 渲染**：使用 Electron `<webview>`（思源主窗口已启用 `webviewTag: true`），可加载任意网站，包括 Google / GitHub / YouTube（不受 X-Frame-Options / CSP 限制）
- **地址栏**：自动补全协议；非 URL 输入回退到默认搜索引擎
- **导航控制**：后退 / 前进 / 刷新 / 强制刷新 / 停止 / 主页
- **页内查找**：Ctrl/Cmd+F 打开查找栏
- **右键菜单**：后退 / 前进 / 刷新 / 在新页签打开 / 复制链接 / 复制图片 / 另存为 / 查看源代码 / 检查元素
- **网页摘录（对齐官方剪藏扩展）**：整页摘录使用 Readability 正文提取 + 内核 lute 转 Markdown（`/api/extension/copy`），按模板组装后创建文档；选区摘录复制 Markdown 到剪贴板；可选下载图片到思源资源库（失败时内核自动转本地）；支持保存路径 / 标签 / 粗斜体下划线样式转换等高级选项
- **Chrome 扩展支持**：在设置中安装未打包的 Chrome 扩展目录或 CRX / ZIP 扩展包（自动解析 CRX 头并解压到插件存储目录），也可直接粘贴 Microsoft Edge 加载项网站的扩展链接或扩展 ID 在线安装（通过 Edge 官方 ondemand 接口下载 CRX 并解压装入），扩展的内容脚本（含 CSS）会按 match pattern 注入到浏览器页签中的网页，并提供 `chrome.storage` / `chrome.i18n` / `chrome.runtime.getURL` 垫片（background / popup 不执行，部分扩展功能可能受限）
- **原生 Electron 扩展加载**：通过 `@electron/remote` 调主进程 `session.loadExtension`，把扩展装入 webview 专用 session（真实 Chromium 内容脚本注入）；原生加载失败的扩展自动回退垫片模式。
- **内置广告过滤（元素隐藏）**：页面加载时按 Adblock `##` 元素隐藏语法注入 CSS（内置常见广告网络与 tgb.cn 等站点规则，支持在设置中添加自定义规则）。渲染进程架构拿不到 webRequest，无法做网络层拦截，AdGuard 这类以网络拦截为主的扩展无法工作。
- **新窗口拦截**：`target="_blank"` 链接和 `window.open()` 在新页签打开，而非系统浏览器
- **书签 Dock**：树形结构 + 文件夹，增删改查，通过 `Plugin.saveData` 持久化
- **历史 Dock**：按今天 / 昨天 / 7 天内 / 更早分组，搜索、清空全部、按日清空
- **下载 Dock**：进度条、状态、重新下载、清空已完成。文件经内核插件 RPC 保存到思源 `data/assets/` 或插件存储
- **设置对话框**：主页、默认搜索引擎（Google / Bing / 百度 / DuckDuckGo / 自定义）、历史上限、记录历史开关、下载位置、User-Agent 覆盖、preload 开关
- **快捷键**：Cmd/Ctrl+T（新页签）、Cmd/Ctrl+W（关闭页签）、Cmd/Ctrl+L（聚焦地址栏）、Cmd/Ctrl+R（刷新）、Shift+Cmd/Ctrl+R（强制刷新）、Cmd/Ctrl+F（查找）、Alt+←/→（后退/前进）、Alt+Cmd/Ctrl+B/Y/J（打开 Dock）
- **链接右键"在浏览器插件中打开"**：思源内任何 `http(s)://` 链接
- **内核插件**：RPC 方法 `download` / `fetchMeta` / `head` 经 `/api/network/forwardProxy` 绕过 CORS

## 安装

### 从本地源码

1. 将项目克隆 / 复制到 `<workspace>/data/plugins/siyuan-plugin-browser/`
2. 运行 `yarn install && yarn run build`（生成 `.src/` 目录）
3. 重启思源，在 **设置 → 集市 → 已下载** 中启用插件

### 从 zip 安装

1. 运行 `yarn run build` 生成 `dist/package.zip`
2. 通过 **集市 → 已下载 → 从本地安装** 导入

## 架构

```
前端 (index.ts)                  内核 (kernel.ts)
─────────────────                ──────────────────
addTab(browser-tab)              rpc.bind("download")
  └─ <webview> + Toolbar         rpc.bind("fetchMeta")
addDock(bookmarks/history/       rpc.bind("head")
  downloads)                     storage.put("downloads/*")
addTopBar(打开浏览器)             /api/file/putFile → assets
addCommand(快捷键)               
eventBus(open-menu-link)         
                                 
        ↕ JSON-RPC 2.0 (this.kernel.rpc.call.*) ↕
```

每个浏览器页签是一个思源自定义页签，内嵌 Electron `<webview>`。webview 在独立 Chromium 进程中运行，不受 iframe / X-Frame-Options 限制。

内核插件通过网络代理（绕过 CORS）和 storage 实现下载与持久化。

## 限制

- 仅桌面 Electron 端可用
- Cookie / 账号与思源主进程共享（无每页签隔离）
- 通过内核插件下载依赖 `forwardProxy`，大文件会在内核内存中缓冲后再写入
- `view-source:` URL 通过 `data:` URL 渲染为转义文本（webview 不原生支持 view-source）

## License

MIT
