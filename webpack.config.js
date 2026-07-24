const path = require("path");
const webpack = require("webpack");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");

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
        },
        resolve: {
            extensions: [".ts", ".js", ".json"],
        },
        externals: {
            siyuan: "commonjs2 siyuan",
        },
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
                    test: /\.css$/,
                    use: [MiniCssExtractPlugin.loader, "css-loader"],
                },
            ],
        },
        plugins: [
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
