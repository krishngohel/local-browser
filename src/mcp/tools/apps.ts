import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { define, err, text, type ToolDeps } from "./_helpers";

export function registerApps(server: McpServer, deps: ToolDeps): void {
  const hub = deps.hub;

  define(
    server,
    deps,
    "apps_session_start",
    "Open up to 6 URLs as a live grid the user can watch (Echo switches into grid view). Returns the tabId for each, in the same order as the URLs given, for use with every tabId-addressed tool. Only one session at a time — call apps_session_end first to start another.",
    { urls: z.array(z.string()).min(1).max(6) },
    async ({ urls }) => {
      try {
        const { tabIds } = hub.createAppsSession(urls);
        return text(JSON.stringify({ tabIds }, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "apps_session_end",
    "End the current applications grid session. Set close to false to keep the tabs open as regular tabs instead of closing them (default: close them).",
    { close: z.boolean().optional() },
    async ({ close }) => {
      try {
        hub.endAppsSession({ close });
        return text("Applications session ended.");
      } catch (e) {
        return err(e);
      }
    },
  );
}
