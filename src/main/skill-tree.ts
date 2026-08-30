import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTransferPrefs } from "./transfer-prefs";

const FALLBACK = `# Echo — LLM skill tree

You are connected to Echo, a local Chrome-compatible desktop browser on THIS computer. Drive it with tools. There is no cloud browser.

If tools named navigate, snapshot, screenshot, watch, search_web exist, use them. Do not invent CSS selectors. Do not ask for evaluate / arbitrary JavaScript.

Always: snapshot before click/type/fill. Use refs like e0, e1. Filling several fields at once (e.g. a job application)? Use fill_form with { ref, value } pairs instead of separate fill/select/click calls. snapshot/screenshot return a photo of the page. watch returns a short live feed for animations. Stop on captcha/login/2FA and ask the user to finish it in the Echo window, then wait_for.
`;

let cached: string | null = null;

export function skillTreePath(): string | null {
  // Required lazily so this module can be bundled for unit tests, where electron is external.
  let appPath = "";
  try {
    appPath = (require("electron") as typeof import("electron")).app.getAppPath();
  } catch {
    /* not running inside electron (unit tests) */
  }
  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, "skills", "ECHO-SKILL-TREE.md")] : []),
    ...(appPath ? [path.join(appPath, "skills", "ECHO-SKILL-TREE.md")] : []),
    path.join(__dirname, "..", "skills", "ECHO-SKILL-TREE.md"),
    path.join(__dirname, "..", "..", "skills", "ECHO-SKILL-TREE.md"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function loadSkillTree(): string {
  if (cached) return cached;
  const file = skillTreePath();
  if (file) {
    try {
      cached = fs.readFileSync(file, "utf8").trim();
      if (cached) return cached;
    } catch {
      /* fall through */
    }
  }
  cached = FALLBACK;
  return cached;
}

export function mcpInstructions(): string {
  const compact = [
    "Echo is a local Chrome-compatible desktop browser on THIS computer. Drive it with these tools.",
    "Do not invent CSS selectors. Do not ask for evaluate / arbitrary JavaScript (not exposed).",
    "snapshot before click/type/fill using refs (e0, e1). Call echo_help or read echo://docs/skill-tree if you need the full guide.",
    "Stop on captcha/login/2FA and ask the user to finish it in the Echo window, then wait_for.",
  ].join("\n");
  if (!getTransferPrefs().skillTreeOnConnect) return compact;
  return `${compact}\n\n${loadSkillTree()}`;
}

export function registerSkillDocs(server: McpServer): void {
  const tree = loadSkillTree();
  server.registerResource(
    "echo-skill-tree",
    "echo://docs/skill-tree",
    {
      description: "How to drive Echo: search, browse, UI testing, recording, and replay. Follow this for every Echo tool call.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "echo://docs/skill-tree",
          mimeType: "text/markdown",
          text: tree,
        },
      ],
    }),
  );
  server.registerPrompt(
    "echo-guide",
    {
      title: "Echo skill tree",
      description: "How to use Echo for browse, search, UI testing, recording, and replay.",
    },
    async () => ({
      description: "Echo skill tree",
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: tree },
        },
      ],
    }),
  );
}
