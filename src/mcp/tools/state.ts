import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { downloadsDir } from "../../main/paths";
import { define, err, text, type ToolDeps } from "./_helpers";

/**
 * Sessions and state: the cookie jar, web storage, cache, and the three local stores Echo
 * keeps for the user (history, downloads, bookmarks).
 *
 * Cookies, storage, and cache all belong to the **active tab's** session, so an incognito tab
 * reads and clears its own data and never the persistent profile's.
 */
export function registerState(server: McpServer, deps: ToolDeps): void {
  const hub = deps.hub;

  define(
    server,
    deps,
    "cookies_get",
    "List cookies, optionally for one URL.",
    { url: z.string().optional() },
    async ({ url }) => {
      try {
        const cookies = await hub.cookiesGet(url);
        if (!cookies.length) return text(url ? `No cookies for ${url}.` : "No cookies in this session.");
        // JSON.stringify drops undefined members, so optional fields simply do not appear.
        const rows = cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
        }));
        return text(JSON.stringify(rows, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "cookies_set",
    "Set a cookie for a URL.",
    {
      name: z.string(),
      value: z.string(),
      url: z.string(),
      expiresDays: z.number().optional(),
      httpOnly: z.boolean().optional(),
      secure: z.boolean().optional(),
    },
    async (cookie) => {
      try {
        await hub.cookiesSet(cookie);
        return text(`Set cookie ${cookie.name} for ${cookie.url}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "cookies_clear",
    "Delete cookies for a URL, or all cookies.",
    { url: z.string().optional() },
    async ({ url }) => {
      try {
        const removed = await hub.cookiesClear(url);
        if (removed === null) return text("Cleared all cookies");
        return text(`Cleared ${removed} cookies`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "storage_get",
    "Read localStorage or sessionStorage (one key or all).",
    { kind: z.enum(["local", "session"]), key: z.string().optional() },
    async ({ kind, key }) => {
      try {
        return text(await hub.storageGet(kind, key, 40_000));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "storage_set",
    "Write or delete a localStorage/sessionStorage key.",
    { kind: z.enum(["local", "session"]), key: z.string(), value: z.string().nullable() },
    async ({ kind, key, value }) => {
      try {
        await hub.storageSet(kind, key, value);
        const store = kind === "local" ? "localStorage" : "sessionStorage";
        return text(value === null ? `Removed ${key} from ${store}` : `Set ${key} in ${store}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "clear_site_data",
    "Clear storage and cache for one origin, or everything.",
    { origin: z.string().optional() },
    async ({ origin }) => {
      try {
        await hub.clearSiteData(origin);
        return text(origin ? `Cleared storage and cache for ${origin}` : "Cleared all storage and cache");
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "history_search",
    "Search Echo's browsing history by URL or title.",
    { query: z.string(), limit: z.number().int().min(1).max(200).optional() },
    async ({ query, limit }) => {
      try {
        const entries = deps.history.search(query, limit ?? 20);
        if (!entries.length) return text(`No history matching "${query}".`);
        return text(JSON.stringify(entries, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "downloads_list",
    "List files downloaded in this session and the downloads folder.",
    {},
    async () => {
      try {
        return text(JSON.stringify({ folder: downloadsDir(), downloads: deps.downloads.list() }, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "bookmarks",
    "List, add, or remove bookmarks (add uses the current page when url is omitted).",
    { action: z.enum(["list", "add", "remove"]), url: z.string().optional(), title: z.string().optional() },
    async ({ action, url, title }) => {
      try {
        if (action === "list") return text(JSON.stringify(deps.bookmarks.list(), null, 2));
        if (action === "add") {
          const target = url || hub.activeUrl();
          const label = title || (url ? "" : hub.activeTitle()) || target;
          const added = deps.bookmarks.add(target, label);
          if (!added) return err(new Error("Open an http(s) page first"));
          return text(JSON.stringify(added, null, 2));
        }
        // Remove takes a bookmark id or its url; either field may carry it.
        const idOrUrl = url || title;
        if (!idOrUrl) return err(new Error("Give the bookmark id or url to remove."));
        return text(deps.bookmarks.remove(idOrUrl) ? `Removed bookmark ${idOrUrl}` : `No bookmark for ${idOrUrl}`);
      } catch (e) {
        return err(e);
      }
    },
  );
}
