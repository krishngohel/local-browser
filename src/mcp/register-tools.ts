import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadSkillTree, registerSkillDocs } from "../main/skill-tree";
import { define, text, type ToolDeps } from "./tools/_helpers";
import { registerBrowse } from "./tools/browse";
import { registerSee } from "./tools/see";
import { registerSearch } from "./tools/search";
import { registerDebug } from "./tools/debug";
import { registerTest } from "./tools/test";
import { registerRecord } from "./tools/record";

export type { ToolDeps } from "./tools/_helpers";

export function registerTools(server: McpServer, deps: ToolDeps): void {
  registerSkillDocs(server);

  define(
    server,
    deps,
    "echo_help",
    "How to drive Echo. Call this if the automatic skill tree is missing or you are unsure which tool to use.",
    {},
    async () => text(loadSkillTree()),
  );

  registerBrowse(server, deps);
  registerSee(server, deps);
  registerSearch(server, deps);
  registerDebug(server, deps);
  registerTest(server, deps);
  registerRecord(server, deps);
}
