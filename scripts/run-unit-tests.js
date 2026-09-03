const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = path.join(__dirname, "..", "test", "unit");
const outDir = path.join(__dirname, "..", "out", "test");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(dir, f));
if (!entries.length) { console.log("no unit tests"); process.exit(0); }
esbuild.buildSync({
  entryPoints: entries, bundle: true, platform: "node", target: "node20", format: "cjs",
  outdir: outDir, outExtension: { ".js": ".cjs" }, external: ["electron", "playwright-core", "electron-updater"], sourcemap: "inline", logLevel: "warning",
});
const r = spawnSync(process.execPath, ["--test", ...fs.readdirSync(outDir).filter((f) => f.endsWith(".cjs")).map((f) => path.join(outDir, f))], { stdio: "inherit" });
process.exit(r.status ?? 1);
