const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const ZipPlugin = require("zip-webpack-plugin");

module.exports = (env, argv) => {
    const isProd = argv.mode === "production";
    return {
        mode: argv.mode,
        devtool: isProd ? false : "source-map",
        entry: "./src/kernel.ts",
        output: {
            path: path.resolve(__dirname, ".src"),
            filename: "kernel.js",
            library: {
                type: "module",
            },
            clean: false,
        },
        experiments: {
            outputModule: true,
        },
        resolve: {
            extensions: [".ts", ".js", ".json"],
        },
        externals: {
            siyuan: "module siyuan",
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
            ],
        },
        plugins: [
            ...(isProd
                ? []
                : [
                      new CopyPlugin({
                          patterns: [
                              { from: "plugin.json", to: "plugin.json" },
                              { from: "icon.png", to: "icon.png", noErrorOnMissing: true },
                              { from: "preview.png", to: "preview.png", noErrorOnMissing: true },
                              { from: "src/i18n", to: "i18n" },
                          ],
                      }),
                  ]),
        ],
    };
};
