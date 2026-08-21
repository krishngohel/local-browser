import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { define, err, text, type ToolDeps } from "./_helpers";

export function registerTest(server: McpServer, deps: ToolDeps): void {
  if (!deps.prefs.toolsTest) return;
  const hub = deps.hub;
  const tests = deps.tests;

  define(
    server,
    deps,
    "viewport_set",
    "Emulate a viewport size for product testing (width x height CSS pixels).",
    { width: z.number(), height: z.number() },
    async ({ width, height }) => {
      try {
        await hub.setViewport(width, height);
        return text(`Viewport ${width}x${height}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(server, deps, "test_start", "Start a test run: screenshot, optional Playwright trace, report folder under userData/runs.", {}, async () => {
    try {
      const dir = await tests.start();
      return text(`Test run started at ${dir}`);
    } catch (e) {
      return err(e);
    }
  });

  define(server, deps, "test_assert_text", "Assert the current page text contains a string (case-insensitive).", { text: z.string() }, async ({ text: needle }) => {
    try {
      const result = await tests.assertText(needle);
      return { isError: !result.ok, content: [{ type: "text" as const, text: result.message }] };
    } catch (e) {
      return err(e);
    }
  });

  define(
    server,
    deps,
    "test_assert_url",
    "Assert the current URL matches a substring or regular expression.",
    { pattern: z.string() },
    async ({ pattern }) => {
      try {
        const result = await tests.assertUrl(pattern);
        return { isError: !result.ok, content: [{ type: "text" as const, text: result.message }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  define(server, deps, "test_end", "Stop the test run, save end screenshot/trace, write report.json.", {}, async () => {
    try {
      const dir = await tests.end();
      return text(`Test run saved to ${dir}`);
    } catch (e) {
      return err(e);
    }
  });
}
