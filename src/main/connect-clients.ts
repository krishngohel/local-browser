import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { mcpUrl, mcpUrlForHost, userDataDir } from "./paths";
import { lanIPv4s } from "./net";
import type { ConnectResult, ConnectSnippets } from "../shared/types";

const SERVER_NAME = "echo";
const LEGACY_SERVER_NAME = "local-browser";

export function cursorMcpPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

export function claudeDesktopConfigPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

/** Windows Store (MSIX) installs read a virtualized copy under Packages\\Claude_*\\LocalCache. */
function claudeMsixConfigPaths(): string[] {
  if (process.platform !== "win32") return [];
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const paths: string[] = [];
  try {
    const packagesDir = path.join(localAppData, "Packages");
    if (!fs.existsSync(packagesDir)) return paths;
    for (const name of fs.readdirSync(packagesDir)) {
      if (!name.startsWith("Claude_")) continue;
      const pkgRoot = path.join(packagesDir, name);
      if (!fs.statSync(pkgRoot).isDirectory()) continue;
      paths.push(path.join(pkgRoot, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
    }
  } catch {
    /* ignore */
  }
  return paths;
}

export function claudeDesktopConfigPaths(): string[] {
  return [...new Set([claudeDesktopConfigPath(), ...claudeMsixConfigPaths()])];
}

function claudeWriteTargets(): string[] {
  return claudeDesktopConfigPaths();
}

function claudeEchoRegistered(json: { mcpServers?: Record<string, unknown> } | null): boolean {
  return Boolean(json?.mcpServers?.[SERVER_NAME] || json?.mcpServers?.[LEGACY_SERVER_NAME]);
}

export function claudeConfigRevealTarget(): string {
  const targets = claudeWriteTargets();
  return (
    targets.find((p) => fs.existsSync(p) && claudeEchoRegistered(readJson(p))) ??
    targets.find((p) => fs.existsSync(p)) ??
    targets[0]
  );
}

export function chatgptCodexConfigPath(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "config.toml");
}

export function connectStatus(): {
  cursorConfigExists: boolean;
  cursorRegistered: boolean;
  claudeConfigExists: boolean;
  claudeRegistered: boolean;
  chatgptConfigExists: boolean;
  chatgptRegistered: boolean;
} {
  const cursorPath = cursorMcpPath();
  const claudePaths = claudeDesktopConfigPaths();
  const gptPath = chatgptCodexConfigPath();
  const cursor = readJson(cursorPath);
  const gpt = fs.existsSync(gptPath) ? fs.readFileSync(gptPath, "utf8") : "";
  return {
    cursorConfigExists: fs.existsSync(cursorPath),
    cursorRegistered: Boolean(cursor?.mcpServers?.[SERVER_NAME] || cursor?.mcpServers?.[LEGACY_SERVER_NAME]),
    claudeConfigExists: claudePaths.some((p) => fs.existsSync(p)),
    claudeRegistered: claudePaths.some((p) => claudeEchoRegistered(readJson(p))),
    chatgptConfigExists: fs.existsSync(gptPath),
    chatgptRegistered: /\[mcp_servers\.echo\]/.test(gpt) || /\[mcp_servers\.local-browser\]/.test(gpt),
  };
}

export function registerCursor(token: string): ConnectResult {
  const file = cursorMcpPath();
  try {
    const json = readJson(file) ?? { mcpServers: {} };
    if (!json.mcpServers || typeof json.mcpServers !== "object") {
      json.mcpServers = {};
    }
    backup(file);
    json.mcpServers[SERVER_NAME] = {
      url: mcpUrl(),
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Echo-Client": "cursor",
      },
    };
    if (json.mcpServers[LEGACY_SERVER_NAME]) {
      json.mcpServers[LEGACY_SERVER_NAME] = json.mcpServers[SERVER_NAME];
    }
    writeJson(file, json);
    return {
      ok: true,
      message: "Wrote Cursor MCP config. Enable echo in Cursor Settings → MCP if it is listed as disabled.",
      path: file,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

function writeClaudeConfig(file: string, entry: ClaudeLaunchEntry): void {
  const json = readJson(file) ?? { mcpServers: {} };
  if (!json.mcpServers || typeof json.mcpServers !== "object") {
    json.mcpServers = {};
  }
  backup(file);
  json.mcpServers[SERVER_NAME] = entry;
  if (json.mcpServers[LEGACY_SERVER_NAME]) {
    json.mcpServers[LEGACY_SERVER_NAME] = entry;
  }
  writeJson(file, json);
}

export function registerClaudeDesktop(token: string): ConnectResult {
  const targets = claudeWriteTargets();
  const entry = claudeLaunchEntry(mcpUrl(), token);
  const written: string[] = [];
  const errors: string[] = [];
  for (const file of targets) {
    try {
      writeClaudeConfig(file, entry);
      if (!claudeEchoRegistered(readJson(file))) {
        errors.push(`${file}: wrote file but echo block missing after verify`);
        continue;
      }
      written.push(file);
    } catch (err) {
      errors.push(`${file}: ${errorMessage(err)}`);
    }
  }
  if (written.length === 0) {
    return { ok: false, message: errors.join(" · ") || "Could not write Claude config." };
  }

  const msixWritten = written.filter((p) => p.includes(`${path.sep}Packages${path.sep}Claude_`));
  const bridge = packagedBridgeLaunch();
  const node = findNode();
  const pathLines = written.map((p) => `· ${p}`).join("\n");
  let steps: string;
  if (bridge) {
    steps =
      "Saved Claude config using Echo itself (no Node.js needed). Next: 1) Keep Echo running. 2) In Claude open the menu → Settings → Developer → Edit Config and confirm an “echo” block exists (Local MCP servers may stay empty until Claude reloads). 3) Fully quit Claude — Cmd+Q on Mac, tray icon → Exit on Windows (closing the chat window is not enough). 4) Reopen Claude and check Settings → Developer → Local MCP servers for “echo”. The hammer icon in chat means MCP is active.";
  } else if (node) {
    steps =
      "Saved Claude config. Keep Echo running, use Claude → Settings → Developer → Edit Config to confirm “echo”, fully quit Claude (tray Exit, not just the window), reopen, then check Local MCP servers.";
  } else {
    steps =
      "Saved Claude config, but Node.js was not found. Install Node from nodejs.org and click Connect again — or install Echo from the GitHub Release (.exe / .dmg) which does not need Node.";
  }
  let message = `${steps}\n\nConfig verified at:\n${pathLines}`;
  if (msixWritten.length) {
    message +=
      "\n\nNote: Claude looks installed from the Microsoft Store. Echo wrote the Store copy too — Edit Config in Claude should show the same echo block.";
  }
  if (errors.length) {
    message += `\n\nSome paths failed: ${errors.join(" · ")}`;
  }
  return { ok: true, message, path: written[0], paths: written };
}

export function registerChatGpt(token: string): ConnectResult {
  const file = chatgptCodexConfigPath();
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, upsertCodexEcho(existing, mcpUrl(), token), "utf8");
    return {
      ok: true,
      message:
        "Wrote ChatGPT / Codex config (~/.codex/config.toml). Fully quit and reopen ChatGPT desktop or Codex so it picks up Echo. chatgpt.com in a browser still cannot reach this computer.",
      path: file,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export function upsertCodexEcho(toml: string, url: string, token: string): string {
  const lines = toml.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\[([^\]]+)\]/);
    if (header) {
      const name = header[1].trim();
      skipping = name === "mcp_servers.echo" || name.startsWith("mcp_servers.echo.") || name === "mcp_servers.local-browser" || name.startsWith("mcp_servers.local-browser.");
    }
    if (!skipping) kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const headerValue = `Bearer ${token}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const block = [
    "",
    "[mcp_servers.echo]",
    `url = "${url}"`,
    "enabled = true",
    `http_headers = { Authorization = "${headerValue}", "X-Echo-Client" = "chatgpt" }`,
    "",
  ].join("\n");
  return `${kept.join("\n")}${block}`;
}

export function connectSnippets(token: string): ConnectSnippets {
  const lans = lanIPv4s();
  const lanUrls = lans.map((ip) => mcpUrlForHost(ip));
  const lanUrl = lanUrls[0] || null;
  return {
    localUrl: mcpUrl(),
    lanUrl,
    lanUrls,
    token,
    httpJson: stringify(httpConfig(mcpUrl(), token)),
    httpLanJson: lanUrl ? stringify(httpConfig(lanUrl, token)) : null,
    stdioJson: stringify(stdioConfig(mcpUrl(), token)),
    stdioLanJson: lanUrl ? stringify(stdioConfig(lanUrl, token)) : null,
    vscodeJson: stringify(vscodeConfig(mcpUrl(), token)),
    vscodeLanJson: lanUrl ? stringify(vscodeConfig(lanUrl, token)) : null,
  };
}

function httpConfig(url: string, token: string) {
  return {
    mcpServers: {
      [SERVER_NAME]: {
        url,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  };
}

function stdioConfig(url: string, token: string) {
  return {
    mcpServers: {
      [SERVER_NAME]: claudeLaunchEntry(url, token),
    },
  };
}

type ClaudeLaunchEntry = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

function claudeLaunchEntry(url: string, token: string): ClaudeLaunchEntry {
  const bridge = packagedBridgeLaunch();
  if (bridge) return bridge;
  const node = findNode();
  const base = stdioLaunch(url, token);
  const env = claudePathEnv(node);
  return env ? { ...base, env } : base;
}

function packagedBridgeLaunch(): ClaudeLaunchEntry | null {
  try {
    if (!app.isPackaged) return null;
    const bridge = path.join(process.resourcesPath, "echo-mcp-bridge.cjs");
    if (!fs.existsSync(bridge)) return null;
    return {
      command: app.getPath("exe"),
      args: [bridge],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        ECHO_USERDATA: userDataDir(),
        ECHO_RESOURCES: process.resourcesPath,
      },
    };
  } catch {
    return null;
  }
}

function claudePathEnv(node: string | null): Record<string, string> | undefined {
  if (!node) return undefined;
  const nodeDir = path.dirname(node);
  const sep = process.platform === "win32" ? ";" : ":";
  const pathValue = `${nodeDir}${sep}${process.env.PATH || ""}`;
  return { PATH: pathValue };
}

function stdioLaunch(url: string, token: string): { command: string; args: string[] } {
  const node = findNode();
  const launcher = writeStdioLauncher(url, token, node);
  if (node && launcher) {
    return { command: node, args: [launcher] };
  }
  if (process.platform === "win32" && launcher) {
    return { command: launcher.replace(/\.cjs$/, ".cmd"), args: [] };
  }
  return stdioLaunchSpec(url, token, "claude");
}

function stdioLaunchSpec(url: string, token: string, client?: string): { command: string; args: string[] } {
  const args = [
    "-y",
    "mcp-remote",
    url,
    "--transport",
    "http-only",
    "--allow-http",
    "--header",
    `Authorization: Bearer ${token}`,
  ];
  if (client) args.push("--header", `X-Echo-Client: ${client}`);
  const npx = spawnNpxSpec(findNode());
  if (npx.command !== "npx" || npx.prefix.length) {
    return { command: npx.command, args: [...npx.prefix, ...args] };
  }
  if (process.platform === "win32") {
    const extra = client ? ` --header "X-Echo-Client: ${client}"` : "";
    return {
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `npx -y mcp-remote ${url} --transport http-only --allow-http --header "Authorization: Bearer ${token}"${extra}`,
      ],
    };
  }
  return { command: "npx", args };
}

function writeStdioLauncher(url: string, token: string, node: string | null): string | null {
  try {
    const dir = userDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const jsPath = path.join(dir, "echo-mcp.cjs");
    const header = `Authorization: Bearer ${token}`;
    const npx = spawnNpxSpec(node);
    const nodeDir = node ? path.dirname(node) : "";
    const js = `"use strict";
const { spawn } = require("child_process");
const path = require("path");
const command = ${JSON.stringify(npx.command)};
const prefix = ${JSON.stringify(npx.prefix)};
const nodeDir = ${JSON.stringify(nodeDir)};
const args = ${JSON.stringify(["-y", "mcp-remote", url, "--transport", "http-only", "--allow-http", "--header", header, "--header", "X-Echo-Client: claude"])};
const env = { ...process.env, PATH: (nodeDir ? nodeDir + path.delimiter : "") + (process.env.PATH || "") };
const child = spawn(command, [...prefix, ...args], {
  stdio: "inherit",
  windowsHide: true,
  env,
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
`;
    fs.writeFileSync(jsPath, js, "utf8");
    if (process.platform === "win32") {
      const cmdPath = path.join(dir, "echo-mcp.cmd");
      const cmd = `@echo off\r\n${node ? `"${node}"` : "node"} "${jsPath}"\r\n`;
      fs.writeFileSync(cmdPath, cmd, "utf8");
    } else {
      try {
        fs.chmodSync(jsPath, 0o755);
      } catch {
        /* ignore */
      }
    }
    return jsPath;
  } catch {
    return null;
  }
}

function firstExisting(paths: Array<string | undefined | null>): string | null {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function compareNodeVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function newestNodeInVersions(versionsDir: string): string | null {
  try {
    const dirs = fs.readdirSync(versionsDir).filter((name) => name.startsWith("v"));
    dirs.sort((a, b) => compareNodeVersions(b, a));
    for (const name of dirs) {
      const candidate = path.join(versionsDir, name, "bin", "node");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* missing nvm */
  }
  return null;
}

function firstHomebrewNode(): string | null {
  for (const opt of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    try {
      const names = fs.readdirSync(opt).filter((n) => n === "node" || n.startsWith("node@"));
      names.sort().reverse();
      for (const name of names) {
        const candidate = path.join(opt, name, "bin", "node");
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      /* missing cellar */
    }
  }
  return null;
}

function findNode(): string | null {
  const envNode = process.env.NODE_BINARY;
  if (envNode && fs.existsSync(envNode)) return envNode;

  if (process.platform === "win32") {
    return firstExisting([
      path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
      process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, "node.exe") : "",
      path.join(process.env["ProgramFiles(Arm)"] || "C:\\Program Files (Arm)", "nodejs", "node.exe"),
    ]);
  }

  const home = os.homedir();
  const nvmDir = process.env.NVM_DIR || path.join(home, ".nvm");
  return firstExisting([
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    firstHomebrewNode(),
    path.join(home, ".volta", "bin", "node"),
    path.join(home, ".local", "share", "fnm", "aliases", "default", "bin", "node"),
    path.join(home, ".fnm", "aliases", "default", "bin", "node"),
    path.join(home, ".asdf", "shims", "node"),
    path.join(home, ".local", "share", "mise", "shims", "node"),
    path.join(home, ".nodenv", "shims", "node"),
    newestNodeInVersions(path.join(nvmDir, "versions", "node")),
    "/usr/bin/node",
  ]);
}

function npxCliBeside(node: string): string {
  const dir = path.dirname(node);
  const unix = path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js");
  const win = path.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
  if (fs.existsSync(win)) return win;
  if (fs.existsSync(unix)) return unix;
  const sibling = path.join(dir, process.platform === "win32" ? "npx.cmd" : "npx");
  if (fs.existsSync(sibling)) return sibling;
  return "";
}

function spawnNpxSpec(node: string | null): { command: string; prefix: string[] } {
  if (node) {
    const cli = npxCliBeside(node);
    if (cli.endsWith(".js")) return { command: node, prefix: [cli] };
    if (cli) return { command: cli, prefix: [] };
  }
  return { command: "npx", prefix: [] };
}

function vscodeConfig(url: string, token: string) {
  return {
    servers: {
      [SERVER_NAME]: {
        url,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  };
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function readJson(file: string): { mcpServers?: Record<string, unknown> } | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { mcpServers: {} };
  }
}

function writeJson(file: string, json: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
}

function backup(file: string): void {
  if (!fs.existsSync(file)) return;
  fs.copyFileSync(file, `${file}.bak`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
