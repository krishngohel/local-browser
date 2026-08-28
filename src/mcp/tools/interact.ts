import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { define, err, text, type ToolDeps } from "./_helpers";
import { uploadsDir } from "../../main/paths";
import { MAX_UPLOAD_FILES_PER_CALL, stageUploadFiles } from "../../main/upload-staging";

/**
 * Interaction depth: the pointer, keyboard, dialog, frame, and zoom controls that go beyond
 * click and type. Every element argument is a `ref` from the latest `snapshot`.
 *
 * `evaluate` lives in this group but stays disabled until the user switches it on in
 * Settings, so arbitrary page JavaScript is never exposed by enabling a tool group alone.
 */
export function registerInteract(server: McpServer, deps: ToolDeps): void {
  const hub = deps.hub;

  define(
    server,
    deps,
    "hover",
    "Hover an element by ref (opens menus, shows tooltips).",
    { ref: z.string() },
    async ({ ref }) => {
      try {
        await hub.hover(ref);
        return text(`Hovered ${ref}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "double_click",
    "Double-click an element by ref.",
    { ref: z.string() },
    async ({ ref }) => {
      try {
        await hub.doubleClick(ref);
        return text(`Double-clicked ${ref}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "right_click",
    "Right-click an element by ref (opens its context menu).",
    { ref: z.string() },
    async ({ ref }) => {
      try {
        await hub.rightClick(ref);
        return text(`Right-clicked ${ref}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "drag",
    "Drag an element by ref onto another ref, or by dx/dy pixels.",
    {
      fromRef: z.string(),
      toRef: z.string().optional(),
      dx: z.number().optional(),
      dy: z.number().optional(),
    },
    async ({ fromRef, toRef, dx, dy }) => {
      try {
        if (!toRef && dx === undefined && dy === undefined) {
          return err(new Error("Give toRef, or dx/dy pixels to drag by."));
        }
        return text(await hub.drag(fromRef, { ref: toRef, dx, dy }));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "keyboard_shortcut",
    "Press a key chord such as Control+Shift+P.",
    { chord: z.string() },
    async ({ chord }) => {
      try {
        await hub.shortcut(chord);
        return text(`Pressed ${chord}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "upload_file",
    "Upload to a file input or upload button by ref. Give local file paths, inline files you write yourself ({name, content, encoding: text|base64}), or both.",
    {
      ref: z.string(),
      paths: z.array(z.string()).optional(),
      files: z
        .array(
          z.object({
            name: z.string().min(1),
            content: z.string(),
            encoding: z.enum(["text", "base64"]).optional(),
          }),
        )
        .max(MAX_UPLOAD_FILES_PER_CALL)
        .optional(),
    },
    async ({ ref, paths, files }) => {
      try {
        if (!paths?.length && !files?.length) {
          return err(new Error("Give paths, files, or both."));
        }
        const staged = files?.length ? stageUploadFiles(uploadsDir(), files) : [];
        return text(await hub.uploadFile(ref, [...(paths ?? []), ...staged]));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "dialog",
    "Set how alerts, confirms, and prompts are answered on this tab (accept or dismiss, optional prompt text) and report the last dialog seen. Covers dialogs raised by the main frame.",
    { action: z.enum(["accept", "dismiss"]), promptText: z.string().optional() },
    async ({ action, promptText }) => {
      try {
        hub.setDialogPolicy({ action, promptText });
        const last = hub.lastDialog();
        const seen = last
          ? `Last dialog: ${last.type} "${last.message}" — ${last.handledAs}ed at ${last.at}`
          : "No dialog seen yet";
        return text(`Dialogs will be ${action}ed${promptText ? ` with "${promptText}"` : ""}. ${seen}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(server, deps, "frames", "List iframes on the page.", {}, async () => {
    try {
      const frames = hub.listFrames();
      const selected = hub.selectedFrame();
      return text(
        JSON.stringify(
          { selected, frames: frames.map((f) => ({ ...f, main: f.index === 0 })) },
          null,
          2,
        ),
      );
    } catch (e) {
      return err(e);
    }
  });

  define(
    server,
    deps,
    "frame_select",
    "Scope snapshot/click/get_text to an iframe by index; omit index to return to the main frame.",
    { index: z.number().int().min(0).optional() },
    async ({ index }) => {
      try {
        const frame = hub.selectFrame(index ?? null);
        if (frame.index === null) return text("Back to the main frame.");
        return text(`Frame ${frame.index} selected: ${frame.url || "(no url)"}. Call snapshot for fresh refs.`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "zoom",
    "Set the page zoom factor (0.25-5), or omit to reset.",
    { factor: z.number().min(0.25).max(5).optional() },
    async ({ factor }) => {
      try {
        return text(`Zoom set to ${hub.zoom(factor ?? "reset")}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "evaluate",
    "Runs JavaScript in the page and returns the JSON result. Enabled by the user in Settings → Transfers.",
    { js: z.string() },
    async ({ js }) => {
      try {
        return text(await hub.evaluate(js, 20_000));
      } catch (e) {
        return err(e);
      }
    },
  );
}
