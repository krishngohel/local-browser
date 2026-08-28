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

/** Group each tool belongs to, by name. Availability is gated on it; so is every call. */
const GROUP_OF = new Map<string, ToolGroup>(TOOL_MANIFEST.map((entry) => [entry.name, entry.group]));

/** The slice of the SDK's RegisteredTool that availability updates need. */
type RegisteredToolControl = { enabled: boolean; enable: () => void; disable: () => void };

type SessionTools = { deps: ToolDeps; tools: Map<string, { tool: RegisteredToolControl; group: ToolGroup }> };

/**
 * Every live session's registered tools, so a Transfers switch can reach sessions that are
 * already connected. Entries are dropped when the session's transport closes.
 */
const liveSessions = new Map<McpServer, SessionTools>();

function wantEnabled(name: string, group: ToolGroup, prefs: TransferPrefs, evaluateEnabled: boolean): boolean {
  if (group === "always") return true;
  if (!prefs[group as keyof TransferPrefs]) return false;
  if (name === "evaluate") return evaluateEnabled;
  return true;
}

/**
 * Re-applies the current Transfers switches (and the evaluate switch) to every connected
 * session. The SDK sends `notifications/tools/list_changed` on each state flip, so an
 * assistant that supports it sees tools appear and disappear without reconnecting. Called
 * from the settings IPC handlers whenever either store changes.
 */
export function refreshToolAvailability(): void {
  const prefs = getTransferPrefs();
  for (const entry of liveSessions.values()) {
    const evaluateEnabled = entry.deps.settings().evaluateEnabled;
    for (const [name, { tool, group }] of entry.tools) {
      const want = wantEnabled(name, group, prefs, evaluateEnabled);
      if (tool.enabled === want) continue;
      if (want) tool.enable();
      else tool.disable();
    }
  }
}

/**
 * Registers one tool and routes it through the activity log (pause + history).
 *
 * Every tool is registered on every session; a tool whose group is switched off is registered
 * disabled, which keeps it out of `listTools`. The Transfers switches then flip the disabled
 * state live via `refreshToolAvailability`, so toggling a group reaches assistants that are
 * already connected — turning on no longer needs a reconnect. The per-call guard below
 * re-reads the stored prefs anyway: a call that races a switch-off is still refused, and the
 * refusal is visible in the activity log.
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
  type Register = (name: string, description: string, schema: ZodRawShape, handler: unknown) => unknown;
  const registered = (server.tool as unknown as Register)(name, description, schema, wrapped) as
    | RegisteredToolControl
    | undefined;
  // Unit tests register against a bare fake whose `tool()` returns nothing; only a real SDK
  // registration is tracked for live switching.
  if (!registered || typeof registered.disable !== "function") return;
  if (!wantEnabled(name, group, deps.prefs, deps.settings().evaluateEnabled)) registered.disable();
  let entry = liveSessions.get(server);
  if (!entry) {
    entry = { deps, tools: new Map() };
    liveSessions.set(server, entry);
    const inner = (server as unknown as { server?: { onclose?: () => void } }).server;
    if (inner) {
      const previousOnClose = inner.onclose;
      inner.onclose = () => {
        previousOnClose?.();
        liveSessions.delete(server);
      };
    }
  }
  entry.tools.set(name, { tool: registered, group });
}
