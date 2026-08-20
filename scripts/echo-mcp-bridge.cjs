"use strict";

/**
 * Claude Desktop stdio bridge — run via Echo with ELECTRON_RUN_AS_NODE=1.
 * Connects Claude's stdio MCP pipe to Echo's local HTTP MCP server.
 * Echo must already be running (tray/menu bar).
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const userData = process.env.ECHO_USERDATA;
const resources = process.env.ECHO_RESOURCES;

if (!userData) {
  console.error("ECHO_USERDATA is not set. Click Connect Claude in Echo Settings again.");
  process.exit(1);
}

const tokenPath = path.join(userData, "mcp-token.txt");
if (!fs.existsSync(tokenPath)) {
  console.error("Echo MCP token not found. Open Echo, then Settings → Connections → Connect Claude.");
  process.exit(1);
}

const token = fs.readFileSync(tokenPath, "utf8").trim();
let port = 18931;
const portPath = path.join(userData, "mcp-port.txt");
if (fs.existsSync(portPath)) {
  const parsed = Number.parseInt(fs.readFileSync(portPath, "utf8").trim(), 10);
  if (parsed > 0) port = parsed;
}

const url = `http://127.0.0.1:${port}/mcp`;

function findMcpRemote() {
  const roots = [resources, path.dirname(process.execPath), __dirname].filter(Boolean);
  for (const root of roots) {
    const candidates = [
      path.join(root, "mcp-remote", "dist", "proxy.js"),
      path.join(root, "app.asar.unpacked", "node_modules", "mcp-remote", "dist", "proxy.js"),
      path.join(root, "node_modules", "mcp-remote", "dist", "proxy.js"),
    ];
    for (const file of candidates) {
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

const mcpRemote = findMcpRemote();
if (!mcpRemote) {
  console.error("mcp-remote not found inside Echo. Reinstall Echo or update to the latest release.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    mcpRemote,
    url,
    "--transport",
    "http-only",
    "--allow-http",
    "--header",
    `Authorization: Bearer ${token}`,
    "--header",
    "X-Echo-Client: claude",
  ],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) {
  console.error(result.error instanceof Error ? result.error.message : String(result.error));
  process.exit(1);
}

process.exit(result.status ?? 1);
