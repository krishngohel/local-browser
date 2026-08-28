import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { define, err, text, type ToolDeps } from "./_helpers";

export function registerRecord(server: McpServer, deps: ToolDeps): void {
  const hub = deps.hub;
  const recorder = deps.recorder;

  define(
    server,
    deps,
    "record_start",
    "Start recording. Captures both the user and this assistant (navigate, click, type, fill, press, scroll, select, search_web, new tab). Playback does not need an LLM. Call this before a flow you want to replay later. Optional name.",
    { name: z.string().optional() },
    async ({ name }) => {
      try {
        const state = recorder.start(name, hub.activeUrl() || undefined);
        return text(`Recording “${state.name}”. Your clicks and this assistant’s tools will be saved. Call record_stop when the flow is done.`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(server, deps, "record_stop", "Stop the current recording and save it on this computer.", {}, async () => {
    try {
      const rec = recorder.stop();
      if (!rec) return text("No recording was in progress.");
      return text(`Saved “${rec.name}” (${rec.actions.length} steps, id ${rec.id}).`);
    } catch (e) {
      return err(e);
    }
  });

  define(server, deps, "recordings_list", "List saved recordings (id, name, step count). Playback does not need an LLM.", {}, async () => {
    return text(JSON.stringify(recorder.list(), null, 2));
  });

  define(
    server,
    deps,
    "recording_play",
    "Replay a saved recording by id. Runs locally with no model involved.",
    { id: z.string() },
    async ({ id }) => {
      try {
        const result = await recorder.play(id, hub);
        return { isError: !result.ok, content: [{ type: "text" as const, text: result.message }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  define(server, deps, "recording_delete", "Delete a saved recording by id.", { id: z.string() }, async ({ id }) => {
    try {
      recorder.delete(id);
      return text(`Deleted ${id}`);
    } catch (e) {
      return err(e);
    }
  });
}
