/**
 * 跨 `window.eval` 的全局资源清理注册表（siyuan-plugin-browser 专用）。
 *
 * 思源用 `window.eval` 加载插件，热重载会在同一个页面 JS 上下文里重新求值
 * 整份 bundle：模块级变量全部重置，但挂在 `window` / `document` 上的监听器、
 * 以及注册在 Electron `session.webRequest` 上的回调（session 是宿主级单例，
 * 分区 `persist:siyuan-browser`）不会消失。它们按「份数」累积，回调又捕获
 * 旧 BrowserTab / 插件实例，导致旧 eval 作用域无法 GC，且每个网络请求被
 * 3N 份回调重复处理 —— 渲染进程内存暴涨并卡死事件循环。
 *
 * 注册表挂在 window 上，跨 eval 共享；入口 banner 在下一轮求值的最开始
 * 调用 `__syBrowserDisposeAllGlobal()`（换届自愈，不依赖思源是否调 onunload），
 * `onload` / `onunload` 再各兜一次。
 *
 * 注意：key 与 siyuan-virtual-tree 的 `__syfe...` 不同，两个插件不能共用
 * 同一个注册表，否则一个插件换届会把另一个插件的资源清掉。
 */
const REGISTRY_KEY = "__syBrowserDisposalRegistry";
/** 挂在 Electron session 上，记录本插件注册过的全部 webRequest 回调（跨 eval 存活） */
export const WEB_REQUEST_HANDLERS_KEY = "__syBrowserWrHandlers";

export interface IWebRequestHandler {
    event: string;
    cb: any;
}

interface Registry {
    disposers: Set<() => void>;
    sessions: Set<any>;
}

function registry(): Registry {
    const w = window as any;
    return w[REGISTRY_KEY] || (w[REGISTRY_KEY] = {
        disposers: new Set<() => void>(),
        sessions: new Set<any>(),
    });
}

/** 登记一个清理函数，在本轮插件卸载/换届时执行。 */
export function onDispose(fn: () => void): void {
    registry().disposers.add(fn);
}

/**
 * 注册 webRequest 回调并记账。返回登记项，供单个页签关闭时只摘自己那几个，
 * 避免误伤同轮其它还活着的页签。
 */
export function registerWebRequestHandler(session: any, event: string, cb: any): IWebRequestHandler {
    session.webRequest[event](cb);
    const list: IWebRequestHandler[] = session[WEB_REQUEST_HANDLERS_KEY]
        || (session[WEB_REQUEST_HANDLERS_KEY] = []);
    const item: IWebRequestHandler = {event, cb};
    list.push(item);
    registry().sessions.add(session);
    return item;
}

/** 摘掉 session 上本插件注册的 webRequest 回调。传 only 时只摘指定几项。 */
export function unregisterWebRequestHandlers(session: any, only?: IWebRequestHandler[]): void {
    if (!session) return;
    const list: IWebRequestHandler[] = session[WEB_REQUEST_HANDLERS_KEY] || [];
    const targets = only || list;
    for (const {event, cb} of targets) {
        try {
            session.webRequest?.[event]?.removeListener?.(cb);
        } catch {
            // 单个摘除失败不影响其余
        }
    }
    session[WEB_REQUEST_HANDLERS_KEY] = only
        ? list.filter((x) => !targets.includes(x))
        : [];
}

/** 执行并清空全部清理函数（幂等）。 */
export function disposeAllGlobal(): void {
    const r = registry();
    const list = Array.from(r.disposers);
    r.disposers.clear();
    for (const fn of list) {
        try {
            fn();
        } catch {
            // 单个清理失败不能挡住其余清理
        }
    }
    for (const session of Array.from(r.sessions)) {
        unregisterWebRequestHandlers(session);
    }
    r.sessions.clear();
}

// 入口 banner 在 webpack runtime 之前执行，那时本模块还没求值，拿不到 import；
// 把入口函数挂到 window 上供 banner 直接调用（指向当前轮次的模块作用域）。
(window as any).__syBrowserDisposeAllGlobal = disposeAllGlobal;
(window as any).__syBrowserOnDispose = onDispose;
