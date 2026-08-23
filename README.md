# SiYuan Browser Plugin

A full-featured browser inside [SiYuan Note](https://b3log.org/siyuan), powered by Electron `<webview>`. Supports multi-tab, bookmarks, history.

> ⚠️ Desktop only (Electron). Mobile and browser-access frontends are not supported because the `<webview>` tag is Electron-specific.

## Features

- **Multi-tab browsing** — Each browser tab is a native SiYuan custom tab, draggable / splittable / closable like any other SiYuan tab.
- **Full Chromium rendering** — Uses Electron `<webview>` (SiYuan's main window enables `webviewTag: true`), so any site loads — including Google, GitHub, YouTube (no X-Frame-Options / CSP restrictions).
- **Address bar** — Auto-completes protocols; falls back to default search engine for non-URL input.
- **Navigation controls** — Back / Forward / Reload / Force-reload / Stop / Home.
- **Find in page** — Ctrl/Cmd+F to open the find bar.
- **`new-window` interception** — `target="_blank"` links and `window.open()` open in a new browser tab instead of the system browser.
- **Bookmarks dock** — Tags grouping, add / edit / delete, persisted via `Plugin.saveData`.
- **History dock** — Grouped by Today / Yesterday / Last 7 days / Earlier, search, clear-all, per-day clear.
- **Settings** — Homepage, default search engine (Google / Bing / Baidu / DuckDuckGo / custom), history limit, record history toggle, User-Agent override, preload toggle.
- **Keyboard shortcuts** — Cmd/Ctrl+T (new tab), Cmd/Ctrl+W (close tab), Cmd/Ctrl+L (focus address bar), Cmd/Ctrl+R (reload), Shift+Cmd/Ctrl+R (force reload), Cmd/Ctrl+F (find), Alt+Left/Right (back/forward), Alt+Cmd/Ctrl+B/Y (open dock).
- **Right-click "Open in Browser Plugin"** on any SiYuan link (`http(s)://`).
- **Kernel plugin** — RPC methods `fetchMeta` / `head` bypass CORS via `/api/network/forwardProxy`.

## Installation

### From local source

1. Clone / copy this project to `<workspace>/data/plugins/siyuan-plugin-browser/`
2. Run `pnpm install && pnpm run build` (produces `.src/`)
3. Restart SiYuan, enable the plugin in **Settings → Bazaar → Downloaded**.

### From zip

1. Run `pnpm run build` to generate `dist/package.zip`.
2. Install via **Bazaar → Downloaded → Install from local**.

## Architecture

```
Frontend (index.ts)              Kernel (kernel.ts)
─────────────────                ──────────────────
addTab(browser-tab)              rpc.bind("fetchMeta")
  └─ <webview> + Toolbar         rpc.bind("head")
addDock(bookmarks/history)
addTopBar(Open Browser)
addCommand(shortcuts)
eventBus(open-menu-link)

        ↕ JSON-RPC 2.0 (this.kernel.rpc.call.*) ↕
```

Each browser tab is a SiYuan custom tab embedding an Electron `<webview>`. The webview runs in a separate Chromium process and is not subject to iframe / X-Frame-Options restrictions.

The kernel plugin provides network access (bypassing CORS) via `siyuan.client.fetch("/api/network/forwardProxy")`.

## Files

| Path | Purpose |
|---|---|
| `plugin.json` | Plugin metadata |
| `src/index.ts` | Frontend entry, tab / dock / topbar / command registration |
| `src/kernel.ts` | Kernel entry, RPC methods for fetch / head |
| `src/browser/BrowserTab.ts` | Tab model: webview + toolbar + controller |
| `src/browser/Toolbar.ts` | Address bar + nav buttons + find bar |
| `src/browser/WebviewController.ts` | Event routing, state sync, history |
| `src/docks/BookmarksDock.ts` | Bookmarks dock panel |
| `src/docks/HistoryDock.ts` | History dock panel |
| `src/storage/*.ts` | Stores for bookmarks / history / settings |
| `src/commands/shortcuts.ts` | Keyboard shortcuts |
| `src/index.scss` | Styles (theme-aware) |

## Limitations

- Desktop Electron only.
- Cookies / accounts are shared with the main SiYuan session (no per-tab isolation).

## License

MIT
