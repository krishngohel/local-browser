import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { baselinesDir } from "../../main/paths";
import { decodePng, encodePng, diff } from "../../main/visual";
import { define, err, text, type ToolDeps } from "./_helpers";

/** Antialiasing between two shots of the same page moves channels by a few counts. */
const DIFF_TOLERANCE = 16;
/** Percent of pixels allowed to change before `visual_diff` calls it a regression. */
const DEFAULT_THRESHOLD = 0.5;

/**
 * A baseline name becomes a filename, so it is reduced to lowercase `[a-z0-9_-]`. Two names
 * that differ only by punctuation therefore share a baseline, which is the lesser surprise
 * next to a name that escapes the baselines directory.
 */
function safeName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!safe) throw new Error(`"${name}" has no letters or digits to name a baseline with.`);
  return safe;
}

/** PASS/FAIL is a result, not a tool failure, so these never set `isError`. */
function verdict(ok: boolean, message: string) {
  return text(`${ok ? "PASS" : "FAIL"}: ${message}`);
}

/**
 * Automation and QA: assertions, visual regression, page timing, the request log, and
 * scheduled or partial replay of saved recordings.
 *
 * The assertions work with or without an open test run — they record into the run's report
 * when `test_start` has been called, and simply answer when it has not.
 */
export function registerQa(server: McpServer, deps: ToolDeps): void {
  const hub = deps.hub;
  const tests = deps.tests;

  define(
    server,
    deps,
    "assert_visible",
    "PASS/FAIL: an element (by ref) is visible or text is on the page. Recorded in the active test run.",
    { ref: z.string().optional(), text: z.string().optional() },
    async (args) => {
      try {
        const wanted = args.text?.trim();
        if (!args.ref && !wanted) return err(new Error("Give a ref or some text to look for."));
        let ok: boolean;
        let message: string;
        if (args.ref) {
          const visible = await hub.elementVisible(args.ref);
          ok = visible === true;
          message =
            visible === null
              ? `No element ${args.ref} on the page. Take a snapshot and use a ref from it.`
              : visible
                ? `${args.ref} is visible`
                : `${args.ref} is on the page but not visible`;
        } else {
          const haystack = await hub.pageText();
          ok = haystack.toLowerCase().includes(wanted!.toLowerCase());
          message = ok ? `Found text: ${wanted}` : `Text not found: ${wanted}`;
        }
        const result = tests.assertGeneric("assert_visible", ok, message);
        return verdict(result.ok, result.message);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "assert_url",
    "PASS/FAIL: current URL matches a substring or regex.",
    { pattern: z.string() },
    async ({ pattern }) => {
      try {
        const url = hub.activeUrl();
        // A pattern that compiles is treated as a regex; anything else falls back to a
        // plain substring, so `?` and `(` in a literal URL do not fail the whole check.
        let ok = url.includes(pattern);
        try {
          ok = new RegExp(pattern).test(url);
        } catch {
          ok = url.includes(pattern);
        }
        const message = ok ? `URL matches ${pattern}` : `URL ${url} does not match ${pattern}`;
        const result = tests.assertGeneric("assert_url", ok, message);
        return verdict(result.ok, result.message);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "assert_count",
    "PASS/FAIL: number of matching elements (by role/text) equals expected.",
    { role: z.string().optional(), text: z.string().optional(), expected: z.number().int().min(0) },
    async (args) => {
      try {
        if (!args.role && !args.text?.trim()) {
          return err(new Error("Give a role or some text to count."));
        }
        const matches = await hub.find({ role: args.role, text: args.text });
        const ok = matches.length === args.expected;
        const what = [args.role && `role ${args.role}`, args.text && `text "${args.text}"`]
          .filter(Boolean)
          .join(" and ");
        // `find` searches the snapshot, so this counts interactive elements, not every node
        // in the DOM. Saying so keeps a PASS from reading as a whole-page count.
        const where = "among the interactive elements in the snapshot";
        const message = ok
          ? `${matches.length} element(s) match ${what} ${where}`
          : `Expected ${args.expected} element(s) matching ${what} ${where}, found ${matches.length}`;
        const result = tests.assertGeneric("assert_count", ok, message);
        return verdict(result.ok, result.message);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "visual_baseline",
    "Save a named screenshot baseline of the viewport.",
    { name: z.string() },
    async ({ name }) => {
      try {
        const file = path.join(baselinesDir(), `${safeName(name)}.png`);
        fs.writeFileSync(file, await hub.capturePng());
        return text(`Saved baseline ${safeName(name)} to ${file}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "visual_diff",
    "Compare the viewport to a named baseline; returns changed percent, pass/fail, and a diff image path.",
    { name: z.string(), threshold: z.number().min(0).max(100).optional() },
    async ({ name, threshold }) => {
      try {
        const safe = safeName(name);
        const dir = baselinesDir();
        const baselinePath = path.join(dir, `${safe}.png`);
        if (!fs.existsSync(baselinePath)) {
          return err(new Error(`No baseline named ${safe}. Call visual_baseline first.`));
        }
        const limit = threshold ?? DEFAULT_THRESHOLD;
        const before = decodePng(fs.readFileSync(baselinePath));
        const after = decodePng(await hub.capturePng());
        if (before.width !== after.width || before.height !== after.height) {
          // A resized window is a real difference, but not one a pixel count can describe.
          const reason = `Size changed: baseline ${before.width}x${before.height}, now ${after.width}x${after.height}.`;
          tests.assertGeneric("visual_diff", false, `${safe}: ${reason}`);
          return text(JSON.stringify({ changedPct: null, pass: false, threshold: limit, reason, baselinePath }, null, 2));
        }
        const result = diff(before, after, DIFF_TOLERANCE);
        const diffPath = path.join(dir, `diff-${safe}.png`);
        fs.writeFileSync(diffPath, encodePng(result.diffImage));
        const pass = result.changedPct <= limit;
        tests.assertGeneric(
          "visual_diff",
          pass,
          `${safe}: ${result.changedPct}% of pixels changed (threshold ${limit}%)`,
        );
        return text(
          JSON.stringify(
            { changedPct: result.changedPct, pass, threshold: limit, diffPath, baselinePath },
            null,
            2,
          ),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "perf_timing",
    "Navigation timing (TTFB, DOMContentLoaded, load) plus LCP and CLS if observed.",
    {},
    async () => {
      try {
        return text(JSON.stringify(await hub.perfTiming(), null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "network_log",
    "Recent document and API requests on this tab (method, url, status, type, ms, bytes), newest first. Images, scripts, styles and fonts are not logged.",
    { filter: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    async ({ filter, limit }) => {
      try {
        const entries = hub.networkLog({ filter, limit });
        if (!entries.length) {
          return text(
            filter
              ? `No requests on this tab matching "${filter}".`
              : "No requests logged for this tab yet. Navigate or reload, then try again.",
          );
        }
        return text(JSON.stringify(entries, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "schedule_recording",
    "Replay a saved recording on an interval while Echo is open. action add/list/cancel.",
    {
      action: z.enum(["add", "list", "cancel"]).default("add"),
      recordingId: z.string().optional(),
      everyMinutes: z.number().optional(),
      id: z.string().optional(),
    },
    async ({ action, recordingId, everyMinutes, id }) => {
      try {
        if (action === "list") return text(JSON.stringify(deps.scheduler.list(), null, 2));
        if (action === "cancel") {
          if (!id) return err(new Error("Give the schedule id to cancel. Call action list to see them."));
          if (!deps.scheduler.cancel(id)) return err(new Error(`No schedule ${id}.`));
          return text(`Cancelled ${id}`);
        }
        if (!recordingId || everyMinutes === undefined) {
          return err(new Error("add needs recordingId and everyMinutes. Call recordings_list for ids."));
        }
        // Throws on an unknown id, so a schedule can never point at a recording that is gone.
        deps.recorder.load(recordingId);
        return text(JSON.stringify(deps.scheduler.add(recordingId, everyMinutes), null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  define(
    server,
    deps,
    "run_recording_steps",
    "Play a slice of a saved recording (from step index, optional to).",
    {
      id: z.string(),
      from: z.number().int().min(0).optional(),
      to: z.number().int().min(0).optional(),
    },
    async ({ id, from, to }) => {
      try {
        const result = await deps.recorder.playRange(id, from ?? 0, to, hub);
        return { isError: !result.ok, content: [{ type: "text" as const, text: result.message }] };
      } catch (e) {
        return err(e);
      }
    },
  );
}
