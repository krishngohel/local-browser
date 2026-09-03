import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { captchaSolverReady } from "../../main/captcha-solver-prefs";
import { define, err, text, type ToolDeps, type ToolResult } from "./_helpers";

export function registerRead(server: McpServer, deps: ToolDeps): void {
  const hub = deps.hub;

  define(
    server,
    deps,
    "get_text",
    "Visible text of the page, or of one element by snapshot ref. Optionally target a specific tabId (see tabs_list). Capped at 40,000 chars.",
    { ref: z.string().optional(), maxChars: z.number().int().min(1).max(40000).optional(), tabId: z.string().optional() },
    async ({ ref, maxChars, tabId }) => {
      try {
        const value = await hub.getText(ref, maxChars ?? 40000, tabId);
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
    "Find interactive elements by visible text, role, or label. Returns snapshot refs you can click/type. Optionally target a specific tabId (see tabs_list).",
    {
      text: z.string().optional(),
      role: z.string().optional(),
      label: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      tabId: z.string().optional(),
    },
    async (query) => {
      try {
        if (!query.text && !query.role && !query.label) {
          return err(new Error("Give at least one of text, role, or label."));
        }
        const items = await hub.find(query, query.tabId);
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
    "List links on the page (text + href), optional substring filter, up to 300. Optionally target a specific tabId (see tabs_list).",
    { filter: z.string().optional(), limit: z.number().int().min(1).max(300).optional(), tabId: z.string().optional() },
    async ({ filter, limit, tabId }) => {
      try {
        const links = await hub.links(filter, limit ?? 300, tabId);
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
    "Extract every <table> on the page as markdown (headers + up to maxRows rows each). Optionally target a specific tabId (see tabs_list).",
    { maxRows: z.number().int().min(1).max(500).optional(), tabId: z.string().optional() },
    async ({ maxRows, tabId }) => {
      try {
        const tables = await hub.tables(maxRows ?? 30, tabId);
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
    "List forms and their fields (name, type, value, label, ref) so you can fill them. Optionally target a specific tabId (see tabs_list).",
    { tabId: z.string().optional() },
    async ({ tabId }) => {
      try {
        const forms = await hub.forms(tabId);
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
    "Title, URL, meta description, language, canonical, h1s, and element counts for the page. Optionally target a specific tabId (see tabs_list).",
    { tabId: z.string().optional() },
    async ({ tabId }) => {
      try {
        return text(JSON.stringify(await hub.pageInfo(tabId), null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "html",
    "Outer HTML of the document or of one element by ref. Optionally target a specific tabId (see tabs_list). Capped at 50,000 chars.",
    { ref: z.string().optional(), maxChars: z.number().int().min(1).max(50000).optional(), tabId: z.string().optional() },
    async ({ ref, maxChars, tabId }) => {
      try {
        const result = await hub.html(ref, maxChars ?? 50000, tabId);
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
    "Text of the current PDF, or of the page printed to PDF. Optionally target a specific tabId (see tabs_list).",
    { tabId: z.string().optional() },
    async ({ tabId }) => {
      try {
        const pdf = await hub.pdfText(tabId);
        const pages = pdf.pages ? ` (${pdf.pages} page${pdf.pages === 1 ? "" : "s"})` : "";
        return text(`# ${pdf.title}${pages}\n\n${pdf.text}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "captcha_check",
    "Report whether a CAPTCHA or anti-bot challenge (reCAPTCHA, hCaptcha, Cloudflare Turnstile) is on the page. If a visible puzzle is present and captcha_solve is available, call it. If it is missing or fails, ask the user to solve the puzzle in the Echo window. If present but invisible (a score-based check), don't click the flagged action yourself — hover its ref so the cursor points at it, then ask the user to click it. Optionally target a specific tabId (see tabs_list).",
    { tabId: z.string().optional() },
    async ({ tabId }) => {
      try {
        const found = await hub.detectCaptcha(tabId);
        if (!found.present) return text(JSON.stringify({ present: false }));
        const solverOn = captchaSolverReady();
        const action = !found.visible
          ? "This is invisible/score-based, not a puzzle to solve. Don't click the flagged action yourself — call hover on its ref so the cursor points at it, ask the user to click it, then wait_for the result."
          : solverOn
            ? "Call captcha_solve. If Settings uses Connected assistant, look at the images it returns and call captcha_solve again with tiles, text, or offsetPx. If it fails or the client refuses, ask the user to solve it in the Echo window."
            : "Ask the user to solve it in the Echo window, then continue. captcha_solve is off until the user enables the solver in Settings → System.";
        return text(
          JSON.stringify({
            present: true,
            kind: found.kind,
            visible: found.visible,
            solver: solverOn ? "ready" : "off",
            action,
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "captcha_solve",
    "Attempt to solve a visible CAPTCHA. Settings → System chooses Connected assistant (this model looks at challenge images Echo returns, then call captcha_solve again with tiles, text, or offsetPx) or OpenAI/Gemini with an API key. Supports text CAPTCHAs, reCAPTCHA v2 image grids, and slider puzzles. Score-based invisible checks cannot be solved. Requires the user to enable the solver. Optionally target a specific tabId (see tabs_list).",
    {
      tabId: z.string().optional(),
      challengeId: z.string().optional(),
      tiles: z.array(z.number().int().min(0).max(24)).optional(),
      text: z.string().max(200).optional(),
      offsetPx: z.number().int().min(-260).max(260).optional(),
      skip: z.boolean().optional(),
    },
    async ({ tabId, challengeId, tiles, text: answer, offsetPx, skip }) => {
      try {
        const result = await hub.solveCaptcha(tabId, { challengeId, tiles, text: answer, offsetPx, skip });
        const images = result.images ?? [];
        const { images: _omit, ...rest } = result;
        void _omit;
        const parts: ToolResult["content"] = [{ type: "text", text: JSON.stringify(rest) }];
        for (const png of images.slice(0, 17)) {
          parts.push({ type: "image", mimeType: "image/png", data: png.toString("base64") });
        }
        return { content: parts };
      } catch (e) {
        return err(e);
      }
    },
  );
}
