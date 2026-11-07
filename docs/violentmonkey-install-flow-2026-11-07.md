# 暴力猴（Violentmonkey）安装脚本流程优化（2026-11-07）

> 需求：暴力猴扩展的脚本安装流程优化。此前 VM 走「自身 SW fetch + confirm 页 +
> 手动确认」，SW fetch 常慢于 9s 回落窗口、confirm 页到 SW 的消息通道在本环境
> 挂死（手动点「安装」也无响应），安装成功率与体验都差。

## 终态流程

greasyfork 等站点点「安装此脚本」→ 宿主拦下 .user.js 导航 →

1. **宿主下载**：分区 session fetch（webview 真实 session，await getWebContents
   ——同步调用恒 undefined 会落到系统代理兜底，404 掉本地/部分源）+ greasyfork
   update 域镜像。
2. **已安装检测**：dump VM 存储的 `code:*` 与新内容归一比对，命中即提示跳过。
3. **直装**：在 VM SW 内直接调 VM 自己的 onMessage 处理器（`__syOnMessageHandlers`）
   发 `ParseScript` 命令 —— sender 伪装成 confirm 页（chrome-extension://
   <id>/confirm/index.html#host），否则被 "Command is only allowed in extension
   context" 拒绝。**scr:/code:/mod: 由 VM 自己写入**，schema 与内存一致性全部由
   VM 保证；写入后复核（scr 计数 + 按名命中）。
4. **回落**：直装任一步失败 → 原生链（预取内容喂给垫片 fetch 钩子 → VM 自取
   秒回 → confirm 页 → 按设置自动点「安装」）。自动确认轮询所有活跃浏览器页签
   找 confirm 页（tabs.update 出箱开在**新页签**；重载恢复的旧 confirm 页靠
   页面文本含脚本名排除，否则会点到旧页的 reinstall），设置
   `vmAutoConfirm`（默认开）。

## 实锤的环境坑（修复清单）

1. **confirm 页 → SW 的 runtime.sendMessage 挂死**：ParseScript 永不返回，
   confirm 页 "Loading script data..." 常驻、手动点安装也无响应 —— 这是 VM
   手动流程坏掉的根因，直装绕开了该通道。
2. **webview tag 的 getWebContents 是异步 API**：同步调用恒 undefined，
   fetchViaSession 静默落到 remoteSession 兜底（系统代理 404 掉本地源）。
   已改 await。
3. **死 session 上的 SW eval 永久挂起**：webview 重建后旧 CDP flat session
   失效，evalInSwAny 对其 eval 无超时 → 主窗口兜底永远走不到、整条链卡死。
   evalInSwAny 每通道 15s 竞速超时 → 视同不可用换通道。
4. **测试服务器 .user.js 匹配要剥查询串**（探针 URL 带 ?rN 导致 404 假象）；
   grep 构建产物用 ASCII 特征（esbuild 中文转义 \uXXXX、ANSI 色码截断 grep）。

## VM 2.50.0 存储结构（实测 dump）

`chrome.storage.local` 前缀分桶：`scr:<id>`（{config,custom,meta,props}）、
`code:<id>`（源码全文）、`mod:<id>`（修改时间）、`val:<id>`（GM 存储）、
`req:<uri>`（待装请求缓存）、`cac:`（缓存）、base（options/version）。
安装 = VM 的 ParseScript 命令写 scr/code/mod 三键。

## 探针

tools/probe-vm-db.js（存储 dump）、tools/probe-vm-parse.js（ParseScript 直装
验证）、tools/probe-linenum*.js 等历史探针。诊断口：
`window.browserPlugin.diagEvalInSw(electronId, expr)`（onload 暴露，主窗口用）。
