# 思源浏览器插件

基于 [思源笔记](https://b3log.org/siyuan) 插件系统的内置浏览器，使用 Electron `<webview>` 标签实现，支持多页签、书签、历史。

> ⚠️ 仅桌面端（Electron）可用。移动端与浏览器访问端不可用，因为 `<webview>` 标签是 Electron 专有能力。

## 功能特性

- **多页签浏览**：每个浏览器页签是思源原生自定义页签，可拖拽、拆分窗口、关闭
- **完整 Chromium 渲染**：使用 Electron `<webview>`（思源主窗口已启用 `webviewTag: true`），可加载任意网站，包括 Google / GitHub / YouTube（不受 X-Frame-Options / CSP 限制）
- **地址栏**：自动补全协议；非 URL 输入回退到默认搜索引擎
- **导航控制**：后退 / 前进 / 刷新 / 强制刷新 / 停止 / 主页
- **页内查找**：Ctrl/Cmd+F 打开查找栏
- **新窗口拦截**：`target="_blank"` 链接和 `window.open()` 在新页签打开，而非系统浏览器
- **书签 Dock**：标签分组，增删改查，通过 `Plugin.saveData` 持久化
- **历史 Dock**：按今天 / 昨天 / 7 天内 / 更早分组，搜索、清空全部、按日清空
- **设置**：主页、默认搜索引擎（Google / Bing / 百度 / DuckDuckGo / 自定义）、历史上限、记录历史开关、User-Agent 覆盖、preload 开关
- **快捷键**：Cmd/Ctrl+T（新页签）、Cmd/Ctrl+W（关闭页签）、Cmd/Ctrl+L（聚焦地址栏）、Cmd/Ctrl+R（刷新）、Shift+Cmd/Ctrl+R（强制刷新）、Cmd/Ctrl+F（查找）、Alt+←/→（后退/前进）、Alt+Cmd/Ctrl+B/Y（打开 Dock）
- **链接右键"在浏览器插件中打开"**：思源内任何 `http(s)://` 链接
- **内核插件**：RPC 方法 `fetchMeta` / `head` 经 `/api/network/forwardProxy` 绕过 CORS

## 安装

### 从本地源码

1. 将项目克隆 / 复制到 `<workspace>/data/plugins/siyuan-plugin-browser/`
2. 运行 `pnpm install && pnpm run build`（生成 `.src/` 目录）
3. 重启思源，在 **设置 → 集市 → 已下载** 中启用插件

### 从 zip 安装

1. 运行 `pnpm run build` 生成 `dist/package.zip`
2. 通过 **集市 → 已下载 → 从本地安装** 导入

## 架构

```
前端 (index.ts)                  内核 (kernel.ts)
─────────────────                ──────────────────
addTab(browser-tab)              rpc.bind("fetchMeta")
  └─ <webview> + Toolbar         rpc.bind("head")
addDock(bookmarks/history)
addTopBar(打开浏览器)
addCommand(快捷键)
eventBus(open-menu-link)

        ↕ JSON-RPC 2.0 (this.kernel.rpc.call.*) ↕
```

每个浏览器页签是一个思源自定义页签，内嵌 Electron `<webview>`。webview 在独立 Chromium 进程中运行，不受 iframe / X-Frame-Options 限制。

内核插件通过网络代理（绕过 CORS）提供页面元信息抓取与 HEAD 探测。

## 限制

- 仅桌面 Electron 端可用
- Cookie / 账号与思源主进程共享（无每页签隔离）

## License

MIT
