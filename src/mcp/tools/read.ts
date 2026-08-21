import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { define, err, text, type ToolDeps } from "./_helpers";

export function registerRead(server: McpServer, deps: ToolDeps): void {
  if (!deps.prefs.toolsRead) return;
  const hub = deps.hub;

  define(
    server,
    deps,
    "get_text",
    "Visible text of the page, or of one element by snapshot ref. Capped at 40,000 chars.",
    { ref: z.string().optional(), maxChars: z.number().int().min(1).max(40000).optional() },
    async ({ ref, maxChars }) => {
      try {
        const value = await hub.getText(ref, maxChars ?? 40000);
        return text(value.trim() ? value : "The page has no visible text.");
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "find",
    "Find interactive elements by visible text, role, or label. Returns snapshot refs you can click/type.",
    {
      text: z.string().optional(),
      role: z.string().optional(),
      label: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (query) => {
      try {
        if (!query.text && !query.role && !query.label) {
          return err(new Error("Give at least one of text, role, or label."));
        }
        const items = await hub.find(query);
        if (!items.length) return text("No matches.");
        return text(
          items
            .map((item) => {
              const label = item.label && item.label !== item.name ? ` (label: ${item.label})` : "";
              return `[${item.ref}] <${item.tag}> ${item.name}${label}`;
            })
            .join("\n"),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "links",
    "List links on the page (text + href), optional substring filter, up to 300.",
    { filter: z.string().optional(), limit: z.number().int().min(1).max(300).optional() },
    async ({ filter, limit }) => {
      try {
        const links = await hub.links(filter, limit ?? 300);
        if (!links.length) return text(filter ? `No links matching "${filter}".` : "No links on this page.");
        return text(JSON.stringify(links, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "tables",
    "Extract every <table> on the page as markdown (headers + up to maxRows rows each).",
    { maxRows: z.number().int().min(1).max(500).optional() },
    async ({ maxRows }) => {
      try {
        const tables = await hub.tables(maxRows ?? 30);
        if (!tables.length) return text("No tables on this page.");
        return text(
          tables
            .map((t) => {
              const head = t.headers.length
                ? `| ${t.headers.join(" | ")} |\n| ${t.headers.map(() => "---").join(" | ")} |\n`
                : "";
              const body = t.rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
              const more = t.totalRows > t.rows.length ? `\n(${t.totalRows - t.rows.length} more rows)` : "";
              return `### Table ${t.index}${t.caption ? `: ${t.caption}` : ""}\n${head}${body}${more}`;
            })
            .join("\n\n"),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "forms",
    "List forms and their fields (name, type, value, label, ref) so you can fill them.",
    {},
    async () => {
      try {
        const forms = await hub.forms();
        if (!forms.length) return text("No forms on this page.");
        return text(JSON.stringify(forms, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "page_info",
    "Title, URL, meta description, language, canonical, h1s, and element counts for the page.",
    {},
    async () => {
      try {
        return text(JSON.stringify(await hub.pageInfo(), null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "html",
    "Outer HTML of the document or of one element by ref. Capped at 50,000 chars.",
    { ref: z.string().optional(), maxChars: z.number().int().min(1).max(50000).optional() },
    async ({ ref, maxChars }) => {
      try {
        const result = await hub.html(ref, maxChars ?? 50000);
        const suffix = result.truncated
          ? `\n[truncated: showing ${result.html.length} of ${result.total} chars]`
          : "";
        return text(`${result.html}${suffix}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "pdf_text",
    "Text of the current PDF, or of the page printed to PDF.",
    {},
    async () => {
      try {
        const pdf = await hub.pdfText();
        const pages = pdf.pages ? ` (${pdf.pages} page${pdf.pages === 1 ? "" : "s"})` : "";
        return text(`# ${pdf.title}${pages}\n\n${pdf.text}`);
      } catch (e) {
        return err(e);
      }
    },
  );
}
