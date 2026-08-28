import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { define, text, type ToolDeps } from "./_helpers";

export function registerDebug(server: McpServer, deps: ToolDeps): void {
  const hub = deps.hub;

  define(server, deps, "console_errors", "Recent console errors/warnings from the active tab.", {}, async () => {
    const lines = hub.consoleErrors();
    return text(lines.join("\n") || "(none)");
  });

  define(server, deps, "network_failures", "Recent main-frame HTTP failures and load errors.", {}, async () => {
    const lines = hub.networkFailures();
    return text(lines.join("\n") || "(none)");
  });
}
