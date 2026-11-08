const path = require("path");
const webpack = require("webpack");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");

/**
 * 热重载根治（与 siyuan-virtual-tree 同一套思路）：
 *
 * 思源用 window.eval 加载插件，热重载会在同一页面重新求值整份 bundle。
 * 当前产物是单 bundle（esbuild-loader 把 import() 降级成同步 require），
 * 但一旦将来出现异步分块，webpack 的 jsonp runtime 会对全局 chunk 数组
 * 反复包 push 拦截，旧 runtime 闭包无法 GC（virtual-tree 实测第 2 次热重载
 * 即 4.8GB 卡死）。另外本项目真正的泄漏是挂在 window / document /
 * Electron session 上的资源，故 banner 主要任务是「换届清理」。
 */
const CHUNK_LOADING_GLOBAL = "webpackChunksiyuan_plugin_browser";
const RELOAD_BANNER = `(function(){
var g=typeof self!=="undefined"?self:globalThis;
try{if(g.__syBrowserDisposeAllGlobal)g.__syBrowserDisposeAllGlobal();}catch(e){}
var a=g[${JSON.stringify(CHUNK_LOADING_GLOBAL)}];
if(Array.isArray(a)){a.length=0;a.push=Array.prototype.push;}
})();`;

module.exports = (env, argv) => {
    const isProd = argv.mode === "production";
    return {
        mode: argv.mode,
        devtool: isProd ? false : "source-map",
        entry: "./src/index.ts",
        output: {
            path: path.resolve(__dirname, ".src"),
            filename: "index.js",
            libraryTarget: "commonjs2",
            libraryExport: "default",
            clean: false,
            // 显式固定 jsonp 全局名，与 RELOAD_BANNER 里的 key 同源。
            chunkLoadingGlobal: CHUNK_LOADING_GLOBAL,
        },
        optimization: {
            // 锁死单 bundle 语义：esbuild-loader 目前把 import() 降级为同步
            // require，若将来 loader/target 变化产生真正 split point，
            // jsonp runtime 会立刻回来并带回全局数组累积问题。
            splitChunks: false,
        },
        resolve: {
            extensions: [".ts", ".js", ".json"],
        },
        externals: [
            { siyuan: "commonjs2 siyuan" },
            // 打进 bundle 的依赖（adm-zip）内部会 require node 内置模块。
            // 注意：思源把插件源码包在 function(require, module, exports) 里 eval，
            // require 是它自己的映射函数，所以这里必须用 "var" 表达式形式直接调
            // window.require（Electron 渲染进程 nodeIntegration），不能用
            // "commonjs2 fs" —— 那会生成 require("fs") 并经由加载器 require 转发。
            ({ request }, callback) => {
                if (["fs", "path", "os", "zlib", "crypto"].includes(request)) {
                    callback(null, `var window.require(${JSON.stringify(request)})`);
                } else {
                    callback();
                }
            },
        ],
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    use: {
                        loader: "esbuild-loader",
                        options: {
                            loader: "ts",
                            target: "es2020",
                        },
                    },
                },
                {
                    test: /\.scss$/,
                    use: [MiniCssExtractPlugin.loader, "css-loader", "sass-loader"],
                },
                {
                    // 摘录用的注入脚本（Readability / 剪藏脚本）以原始字符串内嵌，
                    // 在 webview 页面上下文中通过 executeJavaScript 执行
                    test: /Readability\.js$|clipScript\.js$/,
                    type: "asset/source",
                },
                {
                    // 内置广告隐藏规则（adblock 语法文本）同样以字符串内嵌
                    test: /adblock-rules\.txt$/,
                    type: "asset/source",
                },
                {
                    test: /\.css$/,
                    use: [MiniCssExtractPlugin.loader, "css-loader"],
                },
            ],
        },
        plugins: [
            // raw + entryOnly：banner 必须是可执行代码（不是注释），且只能出现在
            // 入口 chunk —— kernel.js 由另一份配置独立编译，不受影响。
            new webpack.BannerPlugin({
                banner: RELOAD_BANNER,
                raw: true,
                entryOnly: true,
            }),
            new webpack.DefinePlugin({
                "process.env.NODE_ENV": JSON.stringify(argv.mode),
            }),
            new MiniCssExtractPlugin({ filename: "index.css" }),
            new CopyPlugin({
                patterns: [
                    { from: "plugin.json", to: "plugin.json" },
                    { from: "icon.png", to: "icon.png", noErrorOnMissing: true },
                    { from: "preview.png", to: "preview.png", noErrorOnMissing: true },
                    { from: "README.md", to: "README.md", noErrorOnMissing: true },
                    { from: "README.zh-CN.md", to: "README.zh-CN.md", noErrorOnMissing: true },
                    { from: "src/i18n", to: "i18n" },
                    { from: "src/preload.js", to: "preload.js" },
                ],
            }),
        ],
    };
};
