/**
 * 将 .src/ 目录打包成 dist/package.zip
 */
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const srcDir = path.resolve(__dirname, "..", ".src");
const distDir = path.resolve(__dirname, "..", "dist");
const zipPath = path.join(distDir, "package.zip");

if (!fs.existsSync(srcDir)) {
    console.error("`.src` directory not found. Run build:app and build:kernel first.");
    process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

const zip = new AdmZip();

function addDir(dir, zipPath = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const entryPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            addDir(fullPath, entryPath);
        } else {
            zip.addLocalFile(fullPath, zipPath);
        }
    }
}

addDir(srcDir);
zip.writeZip(zipPath);

const stats = fs.statSync(zipPath);
console.log(`Created ${path.relative(process.cwd(), zipPath)} (${(stats.size / 1024).toFixed(1)} KB)`);
