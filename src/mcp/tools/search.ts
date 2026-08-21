import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTransferPrefs } from "../../main/transfer-prefs";
import { define, err, text, type ToolDeps } from "./_helpers";

export function registerSearch(server: McpServer, deps: ToolDeps): void {
  if (!deps.prefs.toolsSearch) return;
  const hub = deps.hub;

  define(
    server,
    deps,
    "search_web",
    "Search the web via Google in a real Chrome-compatible tab (no search API). Opens a tab and returns titled results. Recorded if recording is on.",
    { query: z.string() },
    async ({ query }) => {
      try {
        const results = await hub.searchWeb(query);
        return text(JSON.stringify({ query, results }, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "extract_readable",
    "Extract article-like markdown from the current page (nav/chrome stripped).",
    {},
    async () => {
      try {
        if (!getTransferPrefs().readableText) {
          return text("Readable page text is off in Echo Settings → Transfers.");
        }
        const data = await hub.extractReadable();
        return text(`# ${data.title}\n\nSource: ${data.url}\n\n${data.markdown}`);
      } catch (e) {
        return err(e);
      }
    },
  );
}
