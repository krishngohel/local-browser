const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const prod = process.argv.includes("--prod");

async function main() {
  const shared = {
    bundle: true,
    sourcemap: !prod,
    minify: prod,
    logLevel: "info",
  };

  await esbuild.build({
    ...shared,
    entryPoints: ["src/main/index.ts"],
    platform: "node",
    target: "node20",
    outfile: "out/main/index.js",
    external: ["electron", "playwright-core"],
  });

  await esbuild.build({
    ...shared,
    entryPoints: ["src/preload/index.ts"],
    platform: "node",
    target: "node20",
    outfile: "out/preload/index.js",
    external: ["electron"],
  });

  await esbuild.build({
    ...shared,
    entryPoints: ["src/preload/page.ts"],
    platform: "node",
    target: "node20",
    outfile: "out/preload/page.js",
    external: ["electron"],
  });

  await esbuild.build({
    ...shared,
    entryPoints: ["src/renderer/main.ts"],
    platform: "browser",
    target: "es2022",
    outfile: "out/renderer/main.js",
  });

  const rendererDest = path.join("out", "renderer");
  fs.mkdirSync(rendererDest, { recursive: true });
  fs.copyFileSync(path.join("src", "renderer", "index.html"), path.join(rendererDest, "index.html"));
  fs.copyFileSync(path.join("src", "renderer", "styles.css"), path.join(rendererDest, "styles.css"));

  const skillSrc = path.join("skills", "ECHO-SKILL-TREE.md");
  const skillDestDir = path.join("out", "skills");
  if (fs.existsSync(skillSrc)) {
    fs.mkdirSync(skillDestDir, { recursive: true });
    fs.copyFileSync(skillSrc, path.join(skillDestDir, "ECHO-SKILL-TREE.md"));
  }

  const iconSrc = path.join("build", "icon.png");
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join("out", "icon.png"));
  }

  const bridgeSrc = path.join("scripts", "echo-mcp-bridge.cjs");
  const bridgeDestDir = path.join("out", "resources");
  if (fs.existsSync(bridgeSrc)) {
    fs.mkdirSync(bridgeDestDir, { recursive: true });
    fs.copyFileSync(bridgeSrc, path.join(bridgeDestDir, "echo-mcp-bridge.cjs"));
  }

  const mcpRemoteSrc = path.join("node_modules", "mcp-remote");
  const mcpRemoteDest = path.join("out", "resources", "mcp-remote");
  if (fs.existsSync(mcpRemoteSrc)) {
    fs.cpSync(mcpRemoteSrc, mcpRemoteDest, { recursive: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
