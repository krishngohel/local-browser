import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/** Bind all interfaces so this PC’s LAN address can connect. Auth is still the bearer token. */
export const MCP_BIND = "0.0.0.0";
/** Loopback host for same-machine clients. 127.0.0.1 always means this computer, not a developer’s IP. */
export const MCP_HOST = "127.0.0.1";
/** Preferred MCP port. 8931 is Playwright MCP’s default and collides if that tool is running. */
export const MCP_PORT_PREFERRED = 18931;
export const MCP_PORT_SPAN = 10;

let activeMcpPort = MCP_PORT_PREFERRED;

export function mcpPort(): number {
  return activeMcpPort;
}

export function setMcpPort(port: number): void {
  activeMcpPort = port;
}

export function mcpUrl(): string {
  return `http://${MCP_HOST}:${activeMcpPort}/mcp`;
}

export function mcpUrlForHost(host: string, port = activeMcpPort): string {
  return `http://${host}:${port}/mcp`;
}

export const CDP_PORT = 9333;
export const CHROME_HEIGHT = 86;

export function userDataDir(): string {
  return app.getPath("userData");
}

export function downloadsDir(): string {
  const dir = path.join(userDataDir(), "downloads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where `upload_file` stages inline files the assistant writes before setting them on a page. */
export function uploadsDir(): string {
  const dir = path.join(userDataDir(), "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function runsDir(): string {
  const dir = path.join(userDataDir(), "runs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function recordingsDir(): string {
  const dir = path.join(userDataDir(), "recordings");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where `visual_baseline` keeps its named screenshots, alongside the diffs made from them. */
export function baselinesDir(): string {
  const dir = path.join(userDataDir(), "baselines");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tokenPath(): string {
  return path.join(userDataDir(), "mcp-token.txt");
}

export function mcpPortPath(): string {
  return path.join(userDataDir(), "mcp-port.txt");
}

export function writeMcpPortFile(port: number): void {
  try {
    fs.writeFileSync(mcpPortPath(), String(port), "utf8");
  } catch {
    /* ignore */
  }
}

export function partitionName(): string {
  return "persist:local-browser";
}
