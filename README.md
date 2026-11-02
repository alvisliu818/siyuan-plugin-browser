# SiYuan Browser Plugin

A full-featured browser inside [SiYuan Note](https://b3log.org/siyuan), powered by Electron `<webview>`. Supports multi-tab, bookmarks, history, downloads.

> ⚠️ Desktop only (Electron). Mobile and browser-access frontends are not supported because the `<webview>` tag is Electron-specific.

## Features

- **Multi-tab browsing** — Each browser tab is a native SiYuan custom tab, draggable / splittable / closable like any other SiYuan tab.
- **Full Chromium rendering** — Uses Electron `<webview>` (SiYuan's main window enables `webviewTag: true`), so any site loads — including Google, GitHub, YouTube (no X-Frame-Options / CSP restrictions).
- **Address bar** — Auto-completes protocols; falls back to default search engine for non-URL input.
- **Navigation controls** — Back / Forward / Reload / Force-reload / Stop / Home.
- **Find in page** — Ctrl/Cmd+F to open the find bar.
- **Right-click menu** — Back / Forward / Reload / Open in new tab / Copy link / Save image / Save page as / View source / Inspect element.
- **Web clipping (aligned with the official SiYuan clipper extension)** — Full-page clipping uses Readability article extraction plus kernel-side lute HTML→Markdown conversion (`/api/extension/copy`), then creates a document from the default clip template; selection clipping copies Markdown to the clipboard; optional image download to SiYuan assets with kernel-side fallback; configurable save path / tags / bold-italic-underline style preprocessing.
- **Chrome extension support** — Install unpacked Chrome extension folders or CRX / ZIP packages from settings, or paste a Microsoft Edge Add-ons link / extension ID to install directly from the store (downloads the CRX via Edge's official ondemand endpoint and extracts it into the plugin storage directory). CRX headers (v1/v2/v3) are parsed and extracted before installing; extension content scripts (JS + CSS) are injected into web pages by match pattern, with `chrome.storage` / `chrome.i18n` / `chrome.runtime.getURL` shims (background / popup are not executed, so some extensions may be limited).
- **Native Electron extension loading** — Extensions are loaded into the webview's dedicated session via main-process `session.loadExtension` (through `@electron/remote`), giving real Chromium content-script injection; extensions that fail native loading fall back to the shim host.
- **Built-in ad filter (element hiding)** — Injects Adblock-syntax `##` element-hiding CSS per site on page load (bundled rules for common ad networks and tgb.cn, plus user-defined rules in settings). Network-level blocking is not feasible in the renderer-based extension host, so heavy extensions like AdGuard cannot work here.
- **`new-window` interception** — `target="_blank"` links and `window.open()` open in a new browser tab instead of the system browser.
- **Bookmarks dock** — Tree structure with folders, add / edit / delete, persisted via `Plugin.saveData`.
- **History dock** — Grouped by Today / Yesterday / Last 7 days / Earlier, search, clear-all, per-day clear.
- **Downloads dock** — Progress bar, status, redownload, clear completed. Files saved to SiYuan `data/assets/` or plugin storage via the kernel plugin RPC.
- **Settings dialog** — Homepage, default search engine (Google / Bing / Baidu / DuckDuckGo / custom), history limit, record history toggle, download target, User-Agent override, preload toggle.
- **Keyboard shortcuts** — Cmd/Ctrl+T (new tab), Cmd/Ctrl+W (close tab), Cmd/Ctrl+L (focus address bar), Cmd/Ctrl+R (reload), Shift+Cmd/Ctrl+R (force reload), Cmd/Ctrl+F (find), Alt+Left/Right (back/forward), Alt+Cmd/Ctrl+B/Y/J (open dock).
- **Right-click "Open in Browser Plugin"** on any SiYuan link (`http(s)://`).
- **Kernel plugin** — RPC methods `download` / `fetchMeta` / `head` bypass CORS via `/api/network/forwardProxy`.

## Installation

### From local source

1. Clone / copy this project to `<workspace>/data/plugins/siyuan-plugin-browser/`
2. Run `yarn install && yarn run build` (produces `.src/`)
3. Restart SiYuan, enable the plugin in **Settings → Bazaar → Downloaded**.

### From zip

1. Run `yarn run build` to generate `dist/package.zip`.
2. Install via **Bazaar → Downloaded → Install from local**.

## Architecture

```
Frontend (index.ts)              Kernel (kernel.ts)
─────────────────                ──────────────────
addTab(browser-tab)              rpc.bind("download")
  └─ <webview> + Toolbar         rpc.bind("fetchMeta")
addDock(bookmarks/history/       rpc.bind("head")
  downloads)                     storage.put("downloads/*")
addTopBar(Open Browser)          /api/file/putFile → assets
addCommand(shortcuts)            
eventBus(open-menu-link)         
                                 
        ↕ JSON-RPC 2.0 (this.kernel.rpc.call.*) ↕
```

Each browser tab is a SiYuan custom tab embedding an Electron `<webview>`. The webview runs in a separate Chromium process and is not subject to iframe / X-Frame-Options restrictions.

The kernel plugin provides network access (bypassing CORS) and persistence for downloads via `siyuan.client.fetch("/api/network/forwardProxy")` and `siyuan.storage.put`.

## Files

| Path | Purpose |
|---|---|
| `plugin.json` | Plugin metadata |
| `src/index.ts` | Frontend entry, tab / dock / topbar / command registration |
| `src/kernel.ts` | Kernel entry, RPC methods for download / fetch / head |
| `src/browser/BrowserTab.ts` | Tab model: webview + toolbar + controller |
| `src/browser/Toolbar.ts` | Address bar + nav buttons + find bar |
| `src/browser/WebviewController.ts` | Event routing, state sync, history, context menu |
| `src/browser/contextMenu.ts` | Right-click menu in webview |
| `src/docks/BookmarksDock.ts` | Bookmarks dock panel |
| `src/docks/HistoryDock.ts` | History dock panel |
| `src/docks/DownloadsDock.ts` | Downloads dock panel |
| `src/storage/*.ts` | Stores for bookmarks / history / downloads / settings |
| `src/settings/SettingsDialog.ts` | Settings dialog |
| `src/commands/shortcuts.ts` | Keyboard shortcuts |
| `src/index.scss` | Styles (theme-aware) |

## Limitations

- Desktop Electron only.
- Cookies / accounts are shared with the main SiYuan session (no per-tab isolation).
- Downloads via the kernel plugin require `forwardProxy` — large files are buffered in kernel memory before being written.
- `view-source:` URLs are rendered as escaped text via `data:` URL (webview does not natively support view-source).

## License

MIT
