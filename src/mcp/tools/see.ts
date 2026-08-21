import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTransferPrefs } from "../../main/transfer-prefs";
import { define, err, photo, text, type ToolDeps } from "./_helpers";

export function registerSee(server: McpServer, deps: ToolDeps): void {
  if (!deps.prefs.toolsSee) return;
  const hub = deps.hub;

  define(
    server,
    deps,
    "screenshot",
    "Photograph the visible page and return the image so you can see the UI. Use this for visual QA, layout checks, and UI building. Optional fullPage captures the full document.",
    { fullPage: z.boolean().optional() },
    async ({ fullPage }) => {
      try {
        const view = await hub.captureForModel({ fullPage: Boolean(fullPage) });
        const dest = hub.saveCapture(view.png);
        const caption = `Photo of ${hub.activeUrl()} (${view.width}×${view.height}). Saved PNG to ${dest}`;
        if (!getTransferPrefs().screenshotPhoto) {
          return text(`${caption}\n\n(Screenshot image off in Echo Settings → Transfers. File saved locally.)`);
        }
        return photo(caption, view.jpeg);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "watch",
    "Live feed: record the visible page for a short time and return ordered frames so you can see animations, transitions, hover, spinners, carousels, and video. Use this instead of screenshot when motion matters. durationMs 800–6000 (default 2500).",
    { durationMs: z.number().optional(), maxFrames: z.number().optional() },
    async ({ durationMs, maxFrames }) => {
      try {
        if (!getTransferPrefs().watchFrames) {
          return text("Live feed frames are off in Echo Settings → Transfers.");
        }
        const clip = await hub.watch({ durationMs, maxFrames });
        const times = clip.frames.map((frame) => `${frame.tMs}ms`).join(", ");
        const motion =
          clip.frames.length <= 1
            ? "The page looked still during this clip."
            : `Read the ${clip.frames.length} photos in order (t = ${times}).`;
        return {
          content: [
            {
              type: "text" as const,
              text: `Live feed of ${clip.url} (${clip.durationMs}ms).\n${motion}`,
            },
            ...clip.frames.map((frame) => ({
              type: "image" as const,
              mimeType: "image/jpeg",
              data: frame.jpeg.toString("base64"),
            })),
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );
}
