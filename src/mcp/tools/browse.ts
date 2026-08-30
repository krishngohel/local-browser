import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTransferPrefs } from "../../main/transfer-prefs";
import { define, err, photo, text, type ToolDeps } from "./_helpers";

export function registerBrowse(server: McpServer, deps: ToolDeps): void {
  const hub = deps.hub;

  define(server, deps, "tabs_list", "List open browser tabs.", {}, async () => {
    // Favicons are stored as data URLs because the chrome's CSP cannot load remote images.
    // Sending one per tab would cost hundreds of tokens for a thumbnail no assistant can use,
    // so the field reports whether the page has an icon rather than carrying it.
    const tabs = hub.listTabs().map((tab) => ({ ...tab, favicon: tab.favicon !== null }));
    return text(JSON.stringify(tabs, null, 2));
  });

  define(
    server,
    deps,
    "tabs_new",
    "Open a new tab. Optional URL, otherwise the search homepage. Set incognito for a tab with no history, on a throwaway cookie jar shared by incognito tabs and cleared when the last one closes.",
    { url: z.string().optional(), incognito: z.boolean().optional() },
    async ({ url, incognito }) => {
      try {
        const id = hub.assistantCreateTab(url || undefined, { incognito: Boolean(incognito) });
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
        const finalUrl = await hub.assistantNavigate(url, tabId);
        return text(`Navigated to ${finalUrl}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(server, deps, "back", "Go back in history on the active tab.", {}, async () => {
    await hub.back();
    return text("Went back");
  });

  define(server, deps, "reload", "Reload the active tab.", {}, async () => {
    await hub.reload();
    return text("Reloaded");
  });

  define(
    server,
    deps,
    "snapshot",
    "Interactive elements plus a photo of the visible page. Use this to see layout, spacing, and colors. Use refs (e0, e1, …) with click/type/fill/select. Optionally target a specific tabId (see tabs_list).",
    { tabId: z.string().optional() },
    async ({ tabId }) => {
      try {
        const items = await hub.snapshot(tabId);
        const lines = items.map(
          (item) =>
            `[${item.ref}] <${item.tag}> ${item.name}${item.href ? ` ${item.href}` : ""}`,
        );
        // The target tab may not be the active one, so the caption reports its own URL rather
        // than assuming the snapshot came from whatever tab happens to be on screen.
        const targetUrl = tabId ? hub.listTabs().find((t) => t.id === tabId)?.url ?? hub.activeUrl() : hub.activeUrl();
        const caption = `URL: ${targetUrl}\n${lines.join("\n") || "(no interactive elements)"}`;
        if (!getTransferPrefs().snapshotPhoto) {
          return text(`${caption}\n\n(Page photo off in Echo Settings → Transfers.)`);
        }
        try {
          const view = await hub.captureForModel({ tabId });
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

  define(
    server,
    deps,
    "click",
    "Click an element from the latest snapshot by ref (e.g. e3). Recorded if recording is on. Optionally target a specific tabId (see tabs_list).",
    { ref: z.string(), tabId: z.string().optional() },
    async ({ ref, tabId }) => {
      try {
        await hub.click(ref, tabId);
        return text(`Clicked ${ref}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "type",
    "Type into an element from the snapshot. Set submit to press Enter. Recorded if recording is on. Optionally target a specific tabId (see tabs_list).",
    { ref: z.string(), text: z.string(), submit: z.boolean().optional(), tabId: z.string().optional() },
    async ({ ref, text: value, submit, tabId }) => {
      try {
        await hub.typeText(ref, value, Boolean(submit), tabId);
        return text(`Typed into ${ref}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "fill",
    "Clear and fill an input from the snapshot. Optionally target a specific tabId (see tabs_list).",
    { ref: z.string(), value: z.string(), tabId: z.string().optional() },
    async ({ ref, value, tabId }) => {
      try {
        await hub.fill(ref, value, tabId);
        return text(`Filled ${ref}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "press",
    "Press a keyboard key (Playwright key name, e.g. Enter, Tab, Control+l). Optionally target a specific tabId (see tabs_list).",
    { key: z.string(), tabId: z.string().optional() },
    async ({ key, tabId }) => {
      try {
        await hub.press(key, tabId);
        return text(`Pressed ${key}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "scroll",
    "Scroll the page. Positive deltaY scrolls down. Optionally target a specific tabId (see tabs_list).",
    { deltaY: z.number().optional(), tabId: z.string().optional() },
    async ({ deltaY, tabId }) => {
      try {
        await hub.scroll(deltaY ?? 700, tabId);
        return text("Scrolled");
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "select",
    "Choose an option in a <select> from the snapshot. Optionally target a specific tabId (see tabs_list).",
    { ref: z.string(), value: z.string(), tabId: z.string().optional() },
    async ({ ref, value, tabId }) => {
      try {
        await hub.select(ref, value, tabId);
        return text(`Selected ${value} on ${ref}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "fill_form",
    "Fill several fields from the latest snapshot/forms call in one round-trip: { ref, value } pairs. Text/textarea fields are typed, <select> fields choose the option matching value, checkboxes/radios are clicked only when value is truthy (already-checked boxes are not unchecked). Returns a per-field { ref, ok, error? } result so one bad ref does not block the rest. Optionally target a specific tabId.",
    {
      fields: z.array(z.object({ ref: z.string(), value: z.string() })).min(1),
      tabId: z.string().optional(),
    },
    async ({ fields, tabId }) => {
      try {
        const results = await hub.fillForm(fields, tabId);
        return text(JSON.stringify(results, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "wait_for",
    "Wait until the page contains text, or until loading finishes if text is omitted. Optionally target a specific tabId (see tabs_list).",
    { text: z.string().optional(), timeoutMs: z.number().optional(), tabId: z.string().optional() },
    async ({ text: needle, timeoutMs, tabId }) => {
      try {
        await hub.waitFor({ text: needle, timeoutMs }, tabId);
        return text("Wait complete");
      } catch (e) {
        return err(e);
      }
    },
  );
}
