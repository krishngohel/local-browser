import type { z, ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserHub } from "../../main/browser";
import type { TestRunner } from "../../main/test-runs";
import type { Recorder } from "../../main/recordings";
import type { ActivityLog } from "../../main/activity";
import type { History } from "../../main/history";
import type { Bookmarks } from "../../main/bookmarks";
import type { Downloads } from "../../main/downloads";
import type { DialogPolicies } from "../../main/dialogs";
import type { Scheduler } from "../../main/scheduler";
import type { AppSettings, TransferPrefs } from "../../shared/types";
import { GROUP_LABELS, TOOL_MANIFEST, type ToolGroup } from "../../shared/tool-manifest";
import { getTransferPrefs } from "../../main/transfer-prefs";

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
  /** Per-tab alert/confirm/prompt policies, shared with the hub. */
  dialogs: DialogPolicies;
  /** Interval replay of recordings, for `schedule_recording`. */
  scheduler: Scheduler;
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

/** Group each tool belongs to, by name. Registration is gated on it; so is every call. */
const GROUP_OF = new Map<string, ToolGroup>(TOOL_MANIFEST.map((entry) => [entry.name, entry.group]));

/**
 * Registers one tool and routes it through the activity log (pause + history).
 *
 * `deps.prefs` is a snapshot taken when the session registered, so registration alone cannot
 * revoke anything: an assistant that connected while "Sessions and state" was on keeps those
 * tools for the life of its session. The switch is only a real control if every call re-reads
 * it, which is what the wrapper below does. Registration-time gating stays as it is — it is
 * what keeps a turned-off group out of `listTools`.
 */
export function define<S extends ZodRawShape>(
  server: McpServer,
  deps: ToolDeps,
  name: string,
  description: string,
  schema: S,
  handler: (args: { [K in keyof S]: z.infer<S[K]> }) => Promise<ToolResult>,
): void {
  const group = GROUP_OF.get(name) ?? "always";
  const guarded =
    group === "always"
      ? handler
      : async (args: { [K in keyof S]: z.infer<S[K]> }): Promise<ToolResult> => {
          if (!getTransferPrefs()[group as keyof TransferPrefs]) {
            return err(
              `${name} is turned off in Echo Settings → Transfers (${GROUP_LABELS[group]}). Turn the group on and retry.`,
            );
          }
          // `evaluate` carries a second switch of its own, on the same live-read footing.
          if (name === "evaluate" && !deps.settings().evaluateEnabled) {
            return err(
              "evaluate is turned off in Echo Settings → Transfers (Allow evaluate). Turn it back on and retry.",
            );
          }
          return handler(args);
        };
  // The refusal goes through the activity log too, so a user watching the pill sees the call
  // arrive and be turned away rather than seeing nothing at all.
  const wrapped = deps.activity.wrap(name, deps.clientName, guarded);
  // The SDK's generic overloads blow the instantiation depth limit when `schema` is a
  // type parameter, so the registration itself is called through a widened signature.
  type Register = (name: string, description: string, schema: ZodRawShape, handler: unknown) => void;
  (server.tool as unknown as Register)(name, description, schema, wrapped);
}
