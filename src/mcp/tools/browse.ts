import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTransferPrefs } from "../../main/transfer-prefs";
import { define, err, photo, text, type ToolDeps } from "./_helpers";

export function registerBrowse(server: McpServer, deps: ToolDeps): void {
  if (!deps.prefs.toolsBrowse) return;
  const hub = deps.hub;

  define(server, deps, "tabs_list", "List open browser tabs.", {}, async () => {
    // Favicons are stored as data URLs because the chrome's CSP cannot load remote images.
    // Sending one per tab would cost hundreds of tokens for a thumbnail no assistant can use,
    // so the field is truncated to show that the page has an icon without shipping it.
    const tabs = hub.listTabs().map((tab) => ({
      ...tab,
      favicon: tab.favicon ? `${tab.favicon.slice(0, 22)}…` : null,
    }));
    return text(JSON.stringify(tabs, null, 2));
  });

  define(
    server,
    deps,
    "tabs_new",
    "Open a new tab. Optional URL, otherwise the search homepage. Set incognito for a tab with its own throwaway cookie jar and no history.",
    { url: z.string().optional(), incognito: z.boolean().optional() },
    async ({ url, incognito }) => {
      try {
        const id = hub.createTab(url || undefined, { incognito: Boolean(incognito) });
        return text(`Opened ${incognito ? "incognito " : ""}tab ${id}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(server, deps, "tabs_close", "Close a tab by id.", { id: z.string() }, async ({ id }) => {
    try {
      hub.closeTab(id);
      return text(`Closed ${id}`);
    } catch (e) {
      return err(e);
    }
  });

  define(server, deps, "tabs_select", "Focus a tab by id.", { id: z.string() }, async ({ id }) => {
    try {
      hub.selectTab(id);
      return text(`Selected ${id}`);
    } catch (e) {
      return err(e);
    }
  });

  define(
    server,
    deps,
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

  define(server, deps, "back", "Go back in history on the active tab.", {}, async () => {
    hub.back();
    return text("Went back");
  });

  define(server, deps, "reload", "Reload the active tab.", {}, async () => {
    hub.reload();
    return text("Reloaded");
  });

  define(
    server,
    deps,
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

  define(server, deps, "click", "Click an element from the latest snapshot by ref (e.g. e3). Recorded if recording is on.", { ref: z.string() }, async ({ ref }) => {
    try {
      await hub.click(ref);
      return text(`Clicked ${ref}`);
    } catch (e) {
      return err(e);
    }
  });

  define(
    server,
    deps,
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

  define(server, deps, "fill", "Clear and fill an input from the snapshot.", { ref: z.string(), value: z.string() }, async ({ ref, value }) => {
    try {
      await hub.fill(ref, value);
      return text(`Filled ${ref}`);
    } catch (e) {
      return err(e);
    }
  });

  define(server, deps, "press", "Press a keyboard key (Playwright key name, e.g. Enter, Tab, Control+l).", { key: z.string() }, async ({ key }) => {
    try {
      await hub.press(key);
      return text(`Pressed ${key}`);
    } catch (e) {
      return err(e);
    }
  });

  define(server, deps, "scroll", "Scroll the page. Positive deltaY scrolls down.", { deltaY: z.number().optional() }, async ({ deltaY }) => {
    try {
      await hub.scroll(deltaY ?? 700);
      return text("Scrolled");
    } catch (e) {
      return err(e);
    }
  });

  define(
    server,
    deps,
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

  define(
    server,
    deps,
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
