import type { IncomingMessage } from "node:http";

export type McpClientKind = "cursor" | "claude" | "chatgpt" | "other";

export type McpLiveStatus = {
  cursorLive: boolean;
  claudeLive: boolean;
  chatgptLive: boolean;
  otherLive: number;
  liveCount: number;
  otherNames: string[];
};

type SessionRec = {
  id: string;
  kind: McpClientKind;
  name: string;
  lastSeen: number;
};

const sessions = new Map<string, SessionRec>();
let onChange: (() => void) | undefined;

export function setMcpSessionListener(listener?: () => void): void {
  onChange = listener;
}

export function mcpLiveStatus(): McpLiveStatus {
  const list = [...sessions.values()];
  const others = list.filter((s) => s.kind === "other");
  return {
    cursorLive: list.some((s) => s.kind === "cursor"),
    claudeLive: list.some((s) => s.kind === "claude"),
    chatgptLive: list.some((s) => s.kind === "chatgpt"),
    otherLive: others.length,
    liveCount: list.length,
    otherNames: [...new Set(others.map((s) => s.name))],
  };
}

export function dropMcpSession(id: string | undefined): void {
  if (!id || !sessions.delete(id)) return;
  onChange?.();
}

export function noteMcpRequest(
  id: string | undefined,
  req: IncomingMessage,
  client?: { name?: string; version?: string },
): void {
  if (!id) return;
  const ident = identify(req, client);
  const prev = sessions.get(id);
  sessions.set(id, { id, ...ident, lastSeen: Date.now() });
  if (!prev || prev.kind !== ident.kind || prev.name !== ident.name) onChange?.();
}

function identify(
  req: IncomingMessage,
  client?: { name?: string; version?: string },
): { kind: McpClientKind; name: string } {
  const tagged = header(req, "x-echo-client")?.trim().toLowerCase() || "";
  const ua = String(req.headers["user-agent"] || "");
  const clientName = client?.name?.trim() || "";
  const blob = `${tagged} ${clientName} ${ua}`.toLowerCase();

  let kind: McpClientKind = "other";
  if (tagged === "cursor" || /\bcursor\b/.test(blob) || blob.includes("cursor-vscode") || blob.includes("cursor-ide")) {
    kind = "cursor";
  } else if (
    tagged === "claude" ||
    blob.includes("claude") ||
    blob.includes("anthropic") ||
    tagged === "mcp-remote" ||
    blob.includes("mcp-remote")
  ) {
    kind = "claude";
  } else if (
    tagged === "chatgpt" ||
    tagged === "codex" ||
    blob.includes("chatgpt") ||
    blob.includes("codex") ||
    blob.includes("openai")
  ) {
    kind = "chatgpt";
  }

  const name =
    [clientName, client?.version].filter(Boolean).join(" ") ||
    tagged ||
    (ua && ua !== "node" ? ua : "") ||
    "MCP client";
  return { kind, name };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
