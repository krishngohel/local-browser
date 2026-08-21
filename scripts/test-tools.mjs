/**
 * End-to-end MCP tool test.
 *
 *   npm run test:tools      (builds first, then runs this)
 *
 * Starts the fixture server and a real Echo (Electron) on a throwaway profile with every
 * tool group switched on, connects an MCP client over Streamable HTTP, and calls every one
 * of the 69 tools at least once. `search_web` is the single exception: it drives live
 * Google, which has no place in a test that must pass offline.
 *
 * Failures are collected rather than thrown, so one broken tool does not hide the rest; the
 * process exits non-zero if any check failed or any tool went uncalled.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import electronPath from "electron";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PORT = 18999;
const FX = `http://127.0.0.1:${FIXTURE_PORT}`;
/** Matches CDP_PORT in src/main/paths.ts — Playwright attaches to Echo over it. */
const CDP_PORT = 9333;
/** Matches MCP_PORT_PREFERRED / MCP_PORT_SPAN in src/main/paths.ts. */
const MCP_PORT_PREFERRED = 18931;
const MCP_PORT_SPAN = 10;
/** Every tool Echo registers with all groups on and `evaluate` enabled. */
const TOTAL_TOOLS = 69;
/** The one tool the e2e run must not call: it hits live Google. */
const SKIPPED = new Set(["search_web"]);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "echo-e2e-"));
const called = new Set();
const failures = [];
let fixtures = null;
let echo = null;
let cleaned = false;

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ---- process plumbing ------------------------------------------------------

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  if (process.platform === "win32") {
    // Node's kill() on Windows terminates only the process itself; Electron leaves helper
    // processes (and therefore the listening sockets) behind unless the tree goes with it.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

/** Idempotent: runs on the normal path and again from the `exit` backstop. */
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  killTree(echo);
  killTree(fixtures);
  echo = null;
  fixtures = null;
}

/** Waits for a child to exit, then makes sure nothing of its tree is left listening. */
async function stopChild(child, label) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  const settled = await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]);
  if (!settled && process.platform === "win32") {
    console.log(`(${label} did not exit in 2s; killing the process tree)`);
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await Promise.race([exited, sleep(3000)]);
  } else if (!settled) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(3000)]);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (free) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(700);
    socket.once("connect", () => done(false));
    socket.once("timeout", () => done(true));
    socket.once("error", () => done(true));
  });
}

/** A previous run's Electron can take a moment to release its sockets, so this waits. */
async function requireFreePort(port, what, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (await portFree(port)) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `Port ${port} (${what}) is in use. Quit any running Echo (tray icon → Quit) and try again.`,
      );
    }
    await sleep(500);
  }
}

async function waitFor(fn, timeoutMs, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

function readTrimmed(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

// ---- the run ---------------------------------------------------------------

let exitCode = 0;
try {
  await requireFreePort(FIXTURE_PORT, "fixture server");
  await requireFreePort(CDP_PORT, "Echo's remote debugging port");
  let mcpPortFree = false;
  for (let p = MCP_PORT_PREFERRED; p < MCP_PORT_PREFERRED + MCP_PORT_SPAN; p++) {
    if (await portFree(p)) {
      mcpPortFree = true;
      break;
    }
  }
  if (!mcpPortFree) throw new Error(`No free MCP port in ${MCP_PORT_PREFERRED}-${MCP_PORT_PREFERRED + MCP_PORT_SPAN - 1}.`);

  fixtures = spawn(process.execPath, [path.join(REPO, "scripts", "fixture-server.mjs"), String(FIXTURE_PORT)], {
    cwd: REPO,
    stdio: "inherit",
    shell: false,
  });
  fixtures.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`fixture server exited with ${code}`);
  });
  await waitFor(async () => !(await portFree(FIXTURE_PORT)), 10000, "the fixture server to listen");

  echo = spawn(electronPath, ["."], {
    cwd: REPO,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      ECHO_TEST: "1",
      ECHO_TEST_USERDATA: userData,
      ECHO_TEST_HOME: `${FX}/index.html`,
    },
  });
  let echoExit = null;
  echo.on("exit", (code) => {
    echoExit = code;
    if (code === 3) console.error("Echo exited 3: the MCP port was busy.");
  });

  const tokenFile = path.join(userData, "mcp-token.txt");
  const portFile = path.join(userData, "mcp-port.txt");
  const token = await waitFor(
    () => (echoExit === null ? readTrimmed(tokenFile) : Promise.reject(new Error(`Echo exited with ${echoExit}`))),
    45000,
    "mcp-token.txt",
  );
  const port = Number(
    await waitFor(
      () => (echoExit === null ? readTrimmed(portFile) : Promise.reject(new Error(`Echo exited with ${echoExit}`))),
      45000,
      "mcp-port.txt",
    ),
  );
  console.log(`\nEcho MCP on port ${port}, profile ${userData}\n`);

  const client = new Client({ name: "echo-e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );

  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.equal(names.length, TOTAL_TOOLS, `expected ${TOTAL_TOOLS} tools, got ${names.length}: ${names.join(",")}`);

  const call = async (name, args = {}) => {
    called.add(name);
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    const text = (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { ...result, text };
  };
  /** Calls a tool and fails the check if it came back as an error result. */
  const ok = async (name, args = {}) => {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name}(${JSON.stringify(args)}) failed: ${result.text}`);
    return result;
  };
  const json = async (name, args = {}) => JSON.parse((await ok(name, args)).text);
  const refOf = (text, what) => {
    const match = /\[(e\d+)\]/.exec(text);
    if (!match) throw new Error(`No snapshot ref for ${what} in:\n${text}`);
    return match[1];
  };
  const findRef = async (query) => {
    const found = await ok("find", query);
    return refOf(found.text, JSON.stringify(query));
  };

  const check = async (label, fn) => {
    try {
      await fn();
      console.log("ok  ", label);
    } catch (e) {
      failures.push(label);
      console.log("FAIL", label, "-", e.message);
    }
  };

  // `drag` and `upload_file` are Playwright-only, and Playwright attaches over CDP a moment
  // after startup. Waiting for the debugging port keeps the first of those checks from
  // racing the connection.
  await ok("navigate", { url: `${FX}/index.html` });
  await waitFor(async () => !(await portFree(CDP_PORT)), 30000, "Echo's CDP port to open");

  await check("navigate + page_info", async () => {
    await ok("navigate", { url: `${FX}/index.html` });
    const info = await json("page_info");
    assert.equal(info.h1[0], "Echo fixtures");
    assert.match(info.url, /index\.html$/);
  });

  await check("snapshot + find + click + wait_for", async () => {
    const snap = await ok("snapshot");
    assert.match(snap.text, /\[e0\]/);
    await ok("click", { ref: await findRef({ text: "Forms" }) });
    await ok("wait_for", { text: "Form fixture" });
  });

  await check("forms + fill + select + type + get_text", async () => {
    const forms = await json("forms");
    const name = forms[0].fields.find((f) => f.name === "name");
    assert.ok(name?.ref, `no ref on the name field: ${JSON.stringify(forms[0].fields)}`);
    await ok("fill", { ref: name.ref, value: "Ada" });
    await ok("select", { ref: await findRef({ label: "Color" }), value: "green" });
    const shown = await ok("get_text");
    assert.match(shown.text, /Color/);
    await ok("type", { ref: await findRef({ label: "Name" }), text: "Grace", submit: true });
    await ok("wait_for", { text: "submitted: Grace" });
    assert.match((await ok("get_text")).text, /submitted: Grace \/ green/);
  });

  await check("tables", async () => {
    await ok("navigate", { url: `${FX}/tables.html` });
    const tables = await ok("tables", { maxRows: 5 });
    assert.match(tables.text, /35 more rows/);
    assert.match(tables.text, /Table 0: Numbers/);
    assert.match(tables.text, /\| Label \| Amount \| Parity \|/);
  });

  await check("links + html", async () => {
    await ok("navigate", { url: `${FX}/index.html` });
    const links = await json("links", { filter: "tables" });
    assert.equal(links.length, 1, `expected one "tables" link, got ${JSON.stringify(links)}`);
    const html = await ok("html", { maxChars: 100 });
    assert.match(html.text, /truncated/);
  });

  await check("hover + double_click + right_click", async () => {
    const hover = await findRef({ text: "hover me" });
    await ok("hover", { ref: hover });
    assert.match((await ok("assert_visible", { text: "hovered" })).text, /^PASS/);
    await ok("double_click", { ref: hover });
    assert.match((await ok("get_text")).text, /double/);
    await ok("right_click", { ref: hover });
    assert.match((await ok("get_text")).text, /context/);
  });

  await check("drag", async () => {
    await ok("navigate", { url: `${FX}/drag.html` });
    await ok("snapshot");
    const from = await findRef({ text: "source" });
    const to = await findRef({ text: "target" });
    await ok("drag", { fromRef: from, toRef: to });
    assert.match((await ok("get_text")).text, /dropped/);
  });

  await check("dialog", async () => {
    await ok("navigate", { url: `${FX}/dialogs.html` });
    await ok("dialog", { action: "accept" });
    await ok("click", { ref: await findRef({ text: "ask confirm" }) });
    await ok("wait_for", { text: "confirm: true" });
    const seen = await ok("dialog", { action: "dismiss" });
    assert.match(seen.text, /Last dialog: confirm .* accepted at/);
    await ok("click", { ref: await findRef({ text: "ask confirm" }) });
    await ok("wait_for", { text: "confirm: false" });
    await ok("dialog", { action: "accept", promptText: "hi" });
    await ok("click", { ref: await findRef({ text: "show alert" }) });
    await ok("wait_for", { text: "alert done" });
    await ok("click", { ref: await findRef({ text: "ask prompt" }) });
    await ok("wait_for", { text: "prompt: hi" });
    assert.match((await ok("dialog", { action: "accept" })).text, /Last dialog: prompt/);
    // The preload hands the bridge to its shim and then takes it off the page.
    assert.equal(JSON.parse((await ok("evaluate", { js: "typeof window.__echoDialog" })).text), "undefined");
  });

  await check("frames + frame_select", async () => {
    await ok("navigate", { url: `${FX}/iframes.html` });
    const frames = await json("frames");
    assert.ok(frames.frames.length >= 2, `expected the child frame, got ${JSON.stringify(frames)}`);
    await ok("frame_select", { index: 1 });
    assert.match((await ok("snapshot")).text, /inner/i);
    assert.equal((await json("frames")).selected, 1);
    await ok("frame_select", {});
    assert.equal((await json("frames")).selected, null);
  });

  await check("zoom + keyboard_shortcut + evaluate", async () => {
    assert.match((await ok("zoom", { factor: 1.5 })).text, /1\.5/);
    await ok("zoom", {});
    assert.equal(JSON.parse((await ok("evaluate", { js: "1+1" })).text), 2);
    await ok("keyboard_shortcut", { chord: "Control+Home" });
  });

  await check("upload_file", async () => {
    await ok("navigate", { url: `${FX}/forms.html` });
    const upload = path.join(userData, "up.txt");
    fs.writeFileSync(upload, "x");
    const set = await ok("upload_file", { ref: await findRef({ label: "File" }), paths: [upload] });
    assert.match(set.text, /Set 1 file/);
    assert.equal(JSON.parse((await ok("evaluate", { js: "document.getElementById('file').files[0].name" })).text), "up.txt");
  });

  await check("storage + cookies + clear_site_data", async () => {
    await ok("navigate", { url: `${FX}/storage.html` });
    await ok("click", { ref: await findRef({ text: "save to storage" }) });
    assert.equal(JSON.parse((await ok("storage_get", { kind: "local", key: "fixture" })).text), "saved");
    await ok("storage_set", { kind: "local", key: "a", value: "b" });
    assert.equal(JSON.parse((await ok("storage_get", { kind: "local", key: "a" })).text), "b");

    await ok("navigate", { url: `${FX}/cookie-set` });
    const cookies = await json("cookies_get", { url: FX });
    assert.ok(cookies.some((c) => c.name === "fx"), `no fx cookie in ${JSON.stringify(cookies)}`);
    await ok("cookies_set", { name: "k", value: "v", url: FX });
    assert.ok((await json("cookies_get", { url: FX })).some((c) => c.name === "k"));
    await ok("cookies_clear", { url: FX });
    const cleared = await ok("cookies_get", { url: FX });
    assert.match(cleared.text, /No cookies for/);
    await ok("clear_site_data", {});
  });

  await check("history + bookmarks + downloads", async () => {
    assert.ok((await json("history_search", { query: "tables" })).length >= 1);
    const added = await json("bookmarks", { action: "add", url: `${FX}/forms.html`, title: "Forms fixture" });
    assert.match(added.url, /forms\.html$/);
    assert.equal((await json("bookmarks", { action: "list" })).length, 1);
    await ok("bookmarks", { action: "remove", url: `${FX}/forms.html` });
    assert.equal((await json("bookmarks", { action: "list" })).length, 0);
    const downloads = await json("downloads_list");
    assert.ok(typeof downloads.folder === "string" && Array.isArray(downloads.downloads));
  });

  await check("tabs_new incognito + tabs_list + tabs_select + tabs_close", async () => {
    const before = await json("tabs_list");
    const opened = await ok("tabs_new", { url: `${FX}/index.html`, incognito: true });
    const id = /tab-\d+/.exec(opened.text)?.[0];
    assert.ok(id, `no tab id in "${opened.text}"`);
    const listed = await json("tabs_list");
    assert.equal(listed.length, before.length + 1);
    assert.equal(listed.find((t) => t.id === id)?.incognito, true);
    assert.equal(typeof listed[0].favicon, "boolean");
    await ok("tabs_close", { id });
    await ok("tabs_select", { id: before[0].id });
    assert.equal((await json("tabs_list")).length, before.length);
  });

  await check("asserts + visual + perf + network", async () => {
    await ok("navigate", { url: `${FX}/perf.html` });
    await ok("wait_for", { text: "settled" });
    await ok("test_start");
    assert.match((await ok("assert_url", { pattern: "perf" })).text, /^PASS/);
    assert.match((await ok("assert_count", { role: "a", expected: 1 })).text, /^PASS/);
    assert.match((await ok("assert_visible", { text: "Perf fixture" })).text, /^PASS/);
    await ok("test_assert_text", { text: "Perf fixture" });
    await ok("test_assert_url", { pattern: "perf" });
    await ok("visual_baseline", { name: "perf" });
    const diff = await json("visual_diff", { name: "perf" });
    assert.equal(diff.pass, true, `visual_diff regressed: ${JSON.stringify(diff)}`);
    assert.ok(fs.existsSync(diff.diffPath) && fs.existsSync(diff.baselinePath));
    const timing = await json("perf_timing");
    assert.ok(typeof timing.resources === "number", `no timing: ${JSON.stringify(timing)}`);
    assert.ok(timing.load === null || timing.load >= 0);
    const log = await json("network_log", { filter: "perf" });
    assert.ok(log.length >= 1, "no network_log entry for perf.html");
    await call("navigate", { url: `${FX}/status/404` });
    assert.match((await ok("network_failures")).text, /404/);
    const dir = await ok("test_end");
    assert.ok(fs.existsSync(path.join(dir.text.replace(/^Test run saved to /, ""), "report.json")));
  });

  await check("recording + playback + steps + schedule", async () => {
    await ok("record_start", { name: "e2e" });
    await ok("navigate", { url: `${FX}/index.html` });
    await ok("navigate", { url: `${FX}/tables.html` });
    // `record_start` seeds the recording with the page it began on, so the two navigations
    // above make three steps.
    const stopped = await ok("record_stop");
    const steps = Number(/\((\d+) steps/.exec(stopped.text)?.[1]);
    assert.ok(steps >= 3, `expected at least 3 recorded steps, got "${stopped.text}"`);
    const recordings = await json("recordings_list");
    const saved = recordings.find((r) => r.name === "e2e");
    assert.ok(saved, `no "e2e" recording in ${JSON.stringify(recordings)}`);
    assert.match((await ok("run_recording_steps", { id: saved.id, from: 0, to: 1 })).text, /Played/);
    assert.match((await ok("recording_play", { id: saved.id })).text, /Played/);
    const schedule = await json("schedule_recording", { action: "add", recordingId: saved.id, everyMinutes: 60 });
    assert.equal((await json("schedule_recording", { action: "list" })).length, 1);
    await ok("schedule_recording", { action: "cancel", id: schedule.id });
    assert.equal((await json("schedule_recording", { action: "list" })).length, 0);
    await ok("recording_delete", { id: saved.id });
  });

  await check("slow route + wait_for + echo-headers", async () => {
    await ok("navigate", { url: `${FX}/slow.html` });
    await ok("wait_for", { text: "loaded late", timeoutMs: 8000 });
    await ok("navigate", { url: `${FX}/slow?ms=600` });
    assert.match((await ok("get_text")).text, /Waited 600ms/);
    await ok("navigate", { url: `${FX}/echo-headers` });
    assert.match((await ok("get_text")).text, /user-agent/i);
  });

  await check("pdf_text", async () => {
    await ok("navigate", { url: `${FX}/tables.html` });
    assert.match((await ok("pdf_text")).text, /Table fixture/i);
  });

  await check("screenshot + watch + extract_readable", async () => {
    const shot = await ok("screenshot");
    assert.ok(shot.content.some((c) => c.type === "image"), "screenshot returned no image");
    const clip = await ok("watch", { durationMs: 800 });
    assert.match(clip.text, /Live feed/);
    assert.match((await ok("extract_readable")).text, /table/i);
  });

  await check("console_errors + back + reload", async () => {
    // index.html logs one console.error of its own on every load.
    await ok("navigate", { url: `${FX}/index.html` });
    assert.match((await ok("console_errors")).text, /echo fixture console error/);
    await ok("navigate", { url: `${FX}/tables.html` });
    await ok("back");
    await waitFor(
      async () => (await json("page_info")).url.endsWith("/index.html"),
      10000,
      "back to index.html",
    );
    await ok("reload");
    await ok("wait_for", { text: "Echo fixtures" });
  });

  await check("press + scroll + echo_help + viewport_set", async () => {
    await ok("navigate", { url: `${FX}/tables.html` });
    const scrollY = async () => JSON.parse((await ok("evaluate", { js: "window.scrollY" })).text);
    // A real key press needs Playwright: the Electron fallback dispatches a synthetic
    // KeyboardEvent, which carries no default action. Playwright's view of the tab can lag a
    // navigation by a few dozen milliseconds, so the press is retried until it lands.
    await waitFor(
      async () => {
        await ok("press", { key: "End" });
        return (await scrollY()) > 0;
      },
      10000,
      "End to scroll the page down",
    );
    // Chromium animates a keyboard scroll over a few hundred ms. Resetting the position while
    // that animation is still in flight leaves it to finish afterwards, so the reset has to
    // wait for the page to come to rest first.
    await waitFor(
      async () => {
        const before = await scrollY();
        await sleep(150);
        return (await scrollY()) === before;
      },
      5000,
      "the keyboard scroll to settle",
    );
    await ok("evaluate", { js: "window.scrollTo(0, 0)" });
    assert.equal(await scrollY(), 0);
    await ok("scroll", { deltaY: 400 });
    await waitFor(async () => (await scrollY()) > 0, 5000, "scroll to move the page down");
    assert.match((await ok("echo_help")).text, /skill tree/i);
    assert.match((await ok("viewport_set", { width: 800, height: 600 })).text, /800x600/);
  });

  await check("every tool exercised", () => {
    const missed = names.filter((n) => !called.has(n) && !SKIPPED.has(n));
    assert.deepEqual(missed, [], `never called: ${missed.join(", ")}`);
    const strays = [...called].filter((n) => SKIPPED.has(n));
    assert.deepEqual(strays, [], `called a skipped tool: ${strays.join(", ")}`);
    console.log(`     ${called.size} of ${names.length} tools called (skipped: ${[...SKIPPED].join(", ")})`);
  });

  await client.close();
} catch (error) {
  console.error(`\nfatal: ${error instanceof Error ? error.stack : String(error)}`);
  exitCode = 1;
} finally {
  await stopChild(echo, "Echo");
  await stopChild(fixtures, "fixture server");
  cleanup();
}

if (failures.length) {
  console.error(`\n${failures.length} failing: ${failures.join(", ")}`);
  console.error(`the profile with the run's screenshots, baselines and report is at ${userData}`);
  process.exit(1);
}
if (exitCode) {
  console.error(`the profile is at ${userData}`);
  process.exit(exitCode);
}
// Only on success: a failed run's profile holds the report, baselines and diff images.
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
    break;
  } catch {
    // Electron can still hold a handle for a moment after its process tree goes away.
    await sleep(400);
  }
}
console.log("\nall tool checks passed");
