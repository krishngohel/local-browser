import type { z, ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserHub } from "../../main/browser";
import type { TestRunner } from "../../main/test-runs";
import type { Recorder } from "../../main/recordings";
import type { ActivityLog } from "../../main/activity";
import type { History } from "../../main/history";
import type { Bookmarks } from "../../main/bookmarks";
import type { Downloads } from "../../main/downloads";
import type { AppSettings, TransferPrefs } from "../../shared/types";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export type ToolResult = { isError?: boolean; content: ToolContent[] };

export type ToolDeps = {
  hub: BrowserHub;
  tests: TestRunner;
  recorder: Recorder;
  activity: ActivityLog;
  /** Name of the MCP client that owns this session, for the activity log. */
  clientName: () => string;
  history: History;
  bookmarks: Bookmarks;
  downloads: Downloads;
  settings: () => AppSettings;
  /** Snapshot of the transfer prefs taken when the session registered its tools. */
  prefs: TransferPrefs;
  /** Task 6 fills this in with DialogPolicies. */
  dialogs?: unknown;
  /** Task 9 fills this in with Scheduler. */
  scheduler?: unknown;
};

export function text(value: string): ToolResult {
  return { content: [{ type: "text" as const, text: value }] };
}

export function err(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function photo(caption: string, jpeg: Buffer): ToolResult {
  return {
    content: [
      { type: "text" as const, text: caption },
      { type: "image" as const, mimeType: "image/jpeg", data: jpeg.toString("base64") },
    ],
  };
}

/** Registers one tool and routes it through the activity log (pause + history). */
export function define<S extends ZodRawShape>(
  server: McpServer,
  deps: ToolDeps,
  name: string,
  description: string,
  schema: S,
  handler: (args: { [K in keyof S]: z.infer<S[K]> }) => Promise<ToolResult>,
): void {
  const wrapped = deps.activity.wrap(name, deps.clientName, handler);
  // The SDK's generic overloads blow the instantiation depth limit when `schema` is a
  // type parameter, so the registration itself is called through a widened signature.
  type Register = (name: string, description: string, schema: ZodRawShape, handler: unknown) => void;
  (server.tool as unknown as Register)(name, description, schema, wrapped);
}
