import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserHub } from "../main/browser";
import type { TestRunner } from "../main/test-runs";
import type { Recorder } from "../main/recordings";
import { loadSkillTree, registerSkillDocs } from "../main/skill-tree";
import { getTransferPrefs } from "../main/transfer-prefs";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function err(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function photo(caption: string, jpeg: Buffer) {
  return {
    content: [
      { type: "text" as const, text: caption },
      { type: "image" as const, mimeType: "image/jpeg", data: jpeg.toString("base64") },
    ],
  };
}

export function registerTools(server: McpServer, hub: BrowserHub, tests: TestRunner, recorder: Recorder): void {
  const prefs = getTransferPrefs();
  registerSkillDocs(server);

  server.tool(
    "echo_help",
    "How to drive Echo. Call this if the automatic skill tree is missing or you are unsure which tool to use.",
    {},
    async () => text(loadSkillTree()),
  );

  if (prefs.toolsBrowse) {
  server.tool("tabs_list", "List open browser tabs.", {}, async () => {
    return text(JSON.stringify(hub.listTabs(), null, 2));
  });

  server.tool("tabs_new", "Open a new tab. Optional URL, otherwise the search homepage.", { url: z.string().optional() }, async ({ url }) => {
    try {
      const id = hub.createTab(url || undefined);
      return text(`Opened tab ${id}`);
    } catch (e) {
      return err(e);
    }
  });

  server.tool("tabs_close", "Close a tab by id.", { id: z.string() }, async ({ id }) => {
    try {
      hub.closeTab(id);
      return text(`Closed ${id}`);
    } catch (e) {
      return err(e);
    }
  });

  server.tool("tabs_select", "Focus a tab by id.", { id: z.string() }, async ({ id }) => {
    try {
      hub.selectTab(id);
      return text(`Selected ${id}`);
    } catch (e) {
      return err(e);
    }
  });

  server.tool(
    "navigate",
    "Navigate the active tab (or a given tab) to a URL. Bare words are treated as a search. Recorded if recording is on.",
    { url: z.string(), tabId: z.string().optional() },
    async ({ url, tabId }) => {
      try {
        const finalUrl = await hub.navigate(url, tabId);
        return text(`Navigated to ${finalUrl}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool("back", "Go back in history on the active tab.", {}, async () => {
    hub.back();
    return text("Went back");
  });

  server.tool("reload", "Reload the active tab.", {}, async () => {
    hub.reload();
    return text("Reloaded");
  });

  server.tool(
    "snapshot",
    "Interactive elements plus a photo of the visible page. Use this to see layout, spacing, and colors. Use refs (e0, e1, …) with click/type/fill/select.",
    {},
    async () => {
      try {
        const items = await hub.snapshot();
        const lines = items.map(
          (item) =>
            `[${item.ref}] <${item.tag}> ${item.name}${item.href ? ` ${item.href}` : ""}`,
        );
        const caption = `URL: ${hub.activeUrl()}\n${lines.join("\n") || "(no interactive elements)"}`;
        if (!getTransferPrefs().snapshotPhoto) {
          return text(`${caption}\n\n(Page photo off in Echo Settings → Transfers.)`);
        }
        try {
          const view = await hub.captureForModel();
          return photo(`${caption}\n\nPhoto ${view.width}×${view.height}`, view.jpeg);
        } catch (captureError) {
          const reason = captureError instanceof Error ? captureError.message : String(captureError);
          return text(`${caption}\n\n(Photo unavailable: ${reason})`);
        }
      } catch (e) {
        return err(e);
      }
    },
  );
  }

  if (prefs.toolsSee) {
  server.tool(
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

  server.tool(
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

  if (prefs.toolsBrowse) {
  server.tool("click", "Click an element from the latest snapshot by ref (e.g. e3). Recorded if recording is on.", { ref: z.string() }, async ({ ref }) => {
    try {
      await hub.click(ref);
      return text(`Clicked ${ref}`);
    } catch (e) {
      return err(e);
    }
  });

  server.tool(
    "type",
    "Type into an element from the snapshot. Set submit to press Enter. Recorded if recording is on.",
    { ref: z.string(), text: z.string(), submit: z.boolean().optional() },
    async ({ ref, text: value, submit }) => {
      try {
        await hub.typeText(ref, value, Boolean(submit));
        return text(`Typed into ${ref}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool("fill", "Clear and fill an input from the snapshot.", { ref: z.string(), value: z.string() }, async ({ ref, value }) => {
    try {
      await hub.fill(ref, value);
      return text(`Filled ${ref}`);
    } catch (e) {
      return err(e);
    }
  });

  server.tool("press", "Press a keyboard key (Playwright key name, e.g. Enter, Tab, Control+l).", { key: z.string() }, async ({ key }) => {
    try {
      await hub.press(key);
      return text(`Pressed ${key}`);
    } catch (e) {
      return err(e);
    }
  });

  server.tool("scroll", "Scroll the page. Positive deltaY scrolls down.", { deltaY: z.number().optional() }, async ({ deltaY }) => {
    try {
      await hub.scroll(deltaY ?? 700);
      return text("Scrolled");
    } catch (e) {
      return err(e);
    }
  });

  server.tool(
    "select",
    "Choose an option in a <select> from the snapshot.",
    { ref: z.string(), value: z.string() },
    async ({ ref, value }) => {
      try {
        await hub.select(ref, value);
        return text(`Selected ${value} on ${ref}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "wait_for",
    "Wait until the page contains text, or until loading finishes if text is omitted.",
    { text: z.string().optional(), timeoutMs: z.number().optional() },
    async ({ text: needle, timeoutMs }) => {
      try {
        await hub.waitFor({ text: needle, timeoutMs });
        return text("Wait complete");
      } catch (e) {
        return err(e);
      }
    },
  );
  }

  if (prefs.toolsSearch) {
  server.tool(
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

  server.tool(
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

  if (prefs.toolsDebug) {
  server.tool("console_errors", "Recent console errors/warnings from the active tab.", {}, async () => {
    const lines = hub.consoleErrors();
    return text(lines.join("\n") || "(none)");
  });

  server.tool("network_failures", "Recent main-frame HTTP failures and load errors.", {}, async () => {
    const lines = hub.networkFailures();
    return text(lines.join("\n") || "(none)");
  });
  }

  if (prefs.toolsTest) {
  server.tool(
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

  server.tool("test_start", "Start a test run: screenshot, optional Playwright trace, report folder under userData/runs.", {}, async () => {
    try {
      const dir = await tests.start();
      return text(`Test run started at ${dir}`);
    } catch (e) {
      return err(e);
    }
  });

  server.tool("test_assert_text", "Assert the current page text contains a string (case-insensitive).", { text: z.string() }, async ({ text: needle }) => {
    try {
      const result = await tests.assertText(needle);
      return { isError: !result.ok, content: [{ type: "text" as const, text: result.message }] };
    } catch (e) {
      return err(e);
    }
  });

  server.tool(
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

  server.tool("test_end", "Stop the test run, save end screenshot/trace, write report.json.", {}, async () => {
    try {
      const dir = await tests.end();
      return text(`Test run saved to ${dir}`);
    } catch (e) {
      return err(e);
    }
  });
  }

  if (prefs.toolsRecord) {
  server.tool(
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

  server.tool("record_stop", "Stop the current recording and save it on this computer.", {}, async () => {
    try {
      const rec = recorder.stop();
      if (!rec) return text("No recording was in progress.");
      return text(`Saved “${rec.name}” (${rec.actions.length} steps, id ${rec.id}).`);
    } catch (e) {
      return err(e);
    }
  });

  server.tool("recordings_list", "List saved recordings (id, name, step count). Playback does not need an LLM.", {}, async () => {
    return text(JSON.stringify(recorder.list(), null, 2));
  });

  server.tool(
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

  server.tool("recording_delete", "Delete a saved recording by id.", { id: z.string() }, async ({ id }) => {
    try {
      recorder.delete(id);
      return text(`Deleted ${id}`);
    } catch (e) {
      return err(e);
    }
  });
  }
}
