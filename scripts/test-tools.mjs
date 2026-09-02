/**
 * End-to-end MCP tool test.
 *
 *   npm run test:tools      (builds first, then runs this)
 *
 * Starts the fixture server and a real Echo (Electron) on a throwaway profile with every
 * tool group switched on, connects an MCP client over Streamable HTTP, and calls every one
 * of the 76 tools at least once. `search_web` is the single exception: it drives live
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
import { chromium } from "playwright-core";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PORT = 18999;
const FX = `http://127.0.0.1:${FIXTURE_PORT}`;
/** Matches CDP_PORT in src/main/paths.ts — Playwright attaches to Echo over it. */
const CDP_PORT = 9333;
/** Matches MCP_PORT_PREFERRED / MCP_PORT_SPAN in src/main/paths.ts. */
const MCP_PORT_PREFERRED = 18931;
const MCP_PORT_SPAN = 10;
/** Every tool Echo registers with all groups on and `evaluate` enabled. */
const TOTAL_TOOLS = 76;
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
  // The port file appears as soon as the server binds. Poll /health as well so the first
  // tool call never races the rest of Echo's startup.
  await waitFor(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (!res.ok) return false;
        const body = await res.json();
        return body && body.ok === true;
      } catch {
        return false;
      }
    },
    30000,
    "Echo's /health to report ok",
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

  // Same CDP port the tool implementations attach Playwright to for tab automation, connected
  // to directly here so a UI-level check (Settings > Profile) can drive Echo's own chrome
  // window rather than just calling MCP tools. `connectOverCDP` attaches to the app already
  // spawned above; closing it later only disconnects, it does not touch the running Echo.
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const chromeWindow = () => {
    for (const ctx of cdp.contexts()) {
      for (const p of ctx.pages()) {
        if (/renderer[\\/]index\.html/.test(p.url())) return p;
      }
    }
    throw new Error("Echo's chrome window is not among the CDP targets");
  };

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

  await check("fill_form fills text, select, and checkbox fields in one call and reports per-field results", async () => {
    await ok("navigate", { url: `${FX}/forms.html` });
    const forms = await json("forms");
    const nameField = forms[0].fields.find((f) => f.name === "name");
    const colorField = forms[0].fields.find((f) => f.name === "color");
    const agreeField = forms[0].fields.find((f) => f.name === "agree");
    assert.ok(
      nameField?.ref && colorField?.ref && agreeField?.ref,
      `missing refs on name/color/agree: ${JSON.stringify(forms[0].fields)}`,
    );

    const results = await json("fill_form", {
      fields: [
        { ref: nameField.ref, value: "Ada Lovelace" },
        { ref: colorField.ref, value: "blue" },
        { ref: agreeField.ref, value: "true" },
      ],
    });
    assert.equal(results.every((r) => r.ok === true), true, JSON.stringify(results));

    const after = await json("forms");
    assert.equal(after[0].fields.find((f) => f.name === "name")?.value, "Ada Lovelace");
    assert.equal(after[0].fields.find((f) => f.name === "color")?.value, "blue");
    assert.equal(
      JSON.parse((await ok("evaluate", { js: "document.getElementById('agree').checked" })).text),
      true,
      "fill_form should have checked the checkbox",
    );

    // One bad ref is reported per-field rather than blocking the rest of the batch.
    const partial = await json("fill_form", {
      fields: [
        { ref: "e999", value: "x" },
        { ref: nameField.ref, value: "Grace Hopper" },
      ],
    });
    assert.equal(partial[0].ok, false, "bad ref should be reported as not ok");
    assert.ok(partial[0].error, "bad ref result should carry an error message");
    assert.equal(partial[1].ok, true, "the valid field in the same batch should still succeed");
    assert.equal((await json("forms"))[0].fields.find((f) => f.name === "name")?.value, "Grace Hopper");
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

  await check("upload_file inline + chooser button", async () => {
    await ok("navigate", { url: `${FX}/forms.html` });
    const inline = await ok("upload_file", {
      ref: await findRef({ label: "File" }),
      files: [{ name: "note.txt", content: "written by the model" }],
    });
    assert.match(inline.text, /Set 1 file/);
    assert.equal(JSON.parse((await ok("evaluate", { js: "document.getElementById('file').files[0].name" })).text), "note.txt");

    const picked = await ok("upload_file", {
      ref: await findRef({ text: "Pick files" }),
      files: [{ name: "picked.txt", content: "aGVsbG8=", encoding: "base64" }],
    });
    assert.match(picked.text, /file chooser/);
    assert.equal(JSON.parse((await ok("evaluate", { js: "window.__picked" })).text), "picked.txt");
  });

  await check("upload_file still disambiguates a same-URL tab collision after scoping the CDP scan", async () => {
    // playwrightPage() used to scan every open page's CDP target id whenever more than one tab
    // was open, regardless of whether any of them actually shared a URL. That cost scaled with
    // total tab count -- measured ~600ms+ for a page near the end of a 9-page list against a
    // same-machine fixture server, ~90ms after scoping the scan to same-URL candidates only --
    // and under real-world CDP latency could burn through requirePlaywrightPage's 2s budget;
    // upload_file has no non-Playwright fallback, so it failed outright with a misleading "not
    // attached" error even though Playwright was attached the whole time. A reliable timing
    // assertion for that regression needs enough open tabs to matter, but this harness's own
    // real Chromium tabs hit unrelated rendering contention at that scale (verified: an
    // unfixed-vs-fixed timing threshold was flaky in both directions here) -- so this check
    // covers correctness only. The fix's actual perf win is in playwrightPage's own doc comment
    // and was verified by hand against a real multi-tab session, not asserted here.
    const idFirst = /tab-\d+/.exec((await ok("tabs_new", { url: `${FX}/forms.html` })).text)?.[0];
    assert.ok(idFirst, "no tab id for the first same-URL tab");
    const idCollision = /tab-\d+/.exec((await ok("tabs_new", { url: `${FX}/forms.html` })).text)?.[0];
    assert.ok(idCollision, "no tab id for the colliding tab");

    await ok("wait_for", { text: "Form fixture", tabId: idCollision });
    const nameRef = await findRef({ label: "Name", tabId: idCollision });
    await ok("type", { ref: nameRef, text: "Collision Tab", tabId: idCollision });
    const fileRef = await findRef({ label: "File", tabId: idCollision });

    const upload = path.join(userData, "collision-upload.txt");
    fs.writeFileSync(upload, "x");
    const set = await ok("upload_file", { ref: fileRef, paths: [upload], tabId: idCollision });
    assert.match(set.text, /Set 1 file/);

    const collisionFields = (await json("forms", { tabId: idCollision }))[0].fields;
    assert.equal(collisionFields.find((f) => f.name === "name")?.value, "Collision Tab");
    assert.match(collisionFields.find((f) => f.name === "file")?.value ?? "", /collision-upload\.txt/);

    // The earlier tab on the identical URL must be untouched -- proof the collision resolved to
    // the right target, not just the first same-URL match found.
    const firstFields = (await json("forms", { tabId: idFirst }))[0].fields;
    assert.equal(firstFields.find((f) => f.name === "name")?.value, "", "the earlier same-URL tab must be untouched");
    assert.equal(firstFields.find((f) => f.name === "file")?.value, "", "the earlier same-URL tab's file field must be untouched");

    await ok("tabs_close", { id: idFirst });
    await ok("tabs_close", { id: idCollision });
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

  await check("profile_set stores fields and profile_get reads them back", async () => {
    await ok("profile_set", { fullName: "Ada Lovelace", email: "ada@example.com" });
    const profile = await json("profile_get");
    assert.equal(profile.fullName, "Ada Lovelace");
    assert.equal(profile.email, "ada@example.com");
  });

  await check("profile_suggest_fill matches fixture form fields to the stored profile without filling anything", async () => {
    await ok("profile_set", { firstName: "Ada", email: "ada@example.com" });
    await ok("navigate", { url: `${FX}/forms.html` });
    const suggestions = await json("profile_suggest_fill");
    assert.ok(Array.isArray(suggestions), `expected an array of suggestions: ${JSON.stringify(suggestions)}`);
    assert.ok(
      suggestions.some((s) => s.suggestedValue === "Ada" || s.suggestedValue === "ada@example.com"),
      `no suggestion matched the stored profile: ${JSON.stringify(suggestions)}`,
    );
    // A suggestion is not a fill: the underlying inputs must still be untouched.
    const shown = await ok("get_text");
    assert.ok(!shown.text.includes("Ada"), "profile_suggest_fill must not type into the form");
    const after = await json("forms");
    const fields = after[0].fields;
    assert.equal(fields.find((f) => f.name === "firstName")?.value, "");
    assert.equal(fields.find((f) => f.name === "email")?.value, "");
  });

  await check("Settings > Profile stays fresh across a concurrent profile_set (no stale Save clobber)", async () => {
    const win = chromeWindow();
    // openSettings() (settings.ts) is what normally unhides this panel, reached via the app
    // menu / Ctrl+, which route through Electron's main-process input pipeline — unreachable
    // from a page-level CDP session. Flip the one attribute it sets to gate visibility, then
    // drive everything else (section switching, save, the render pipeline) through the real
    // click handlers and `onState` listener already running in the page.
    await win.evaluate(() => {
      document.getElementById("settings").hidden = false;
    });
    await win.click('.nav-item[data-section="profile"]');
    await win.waitForSelector("#profile-fullName", { state: "visible" });

    // Baseline: fill and save from the UI, like a user filling out their own profile.
    await win.fill("#profile-fullName", "Grace Hopper");
    await win.fill("#profile-email", "grace@example.com");
    await win.click("#profile-save");
    await win.waitForTimeout(300);
    assert.equal((await json("profile_get")).fullName, "Grace Hopper");

    // Simulate the assistant writing new values mid-application-fill while the panel is still
    // open — a plain profile_set call, no UI interaction.
    await ok("profile_set", { fullName: "Katherine Johnson", email: "katherine@example.com" });

    // The open panel must pick this up live (profile is part of the AppState broadcast, and
    // every tool call triggers one via activity.setOnChange) rather than keep showing the
    // stale baseline.
    await win.waitForFunction(
      () => document.getElementById("profile-fullName")?.value === "Katherine Johnson",
      undefined,
      { timeout: 5000 },
    );
    assert.equal(await win.inputValue("#profile-email"), "katherine@example.com");

    // Clicking Save now — with the panel showing the freshest values, not what was on screen
    // when it was opened — must not revert the assistant's concurrent write.
    await win.click("#profile-save");
    await win.waitForTimeout(300);
    const after = await json("profile_get");
    assert.equal(after.fullName, "Katherine Johnson", "Save clobbered a concurrent profile_set");
    assert.equal(after.email, "katherine@example.com", "Save clobbered a concurrent profile_set");
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

  await check("apps_session_start opens tabId-addressable OSR tabs; apps_session_end closes them", async () => {
    const before = await json("tabs_list");
    const { tabIds } = await json("apps_session_start", {
      urls: [`${FX}/forms.html?app=1`, `${FX}/tables.html?app=2`],
    });
    assert.equal(tabIds.length, 2);

    // The point of an OSR tab: it is an ordinary tab to every tabId-addressed tool even
    // though it is never attached to the window. Frame delivery itself needs a real
    // compositor, so this asserts addressability and lifecycle, not pixels.
    await ok("wait_for", { text: "Form fixture", tabId: tabIds[0] });
    const info = await json("page_info", { tabId: tabIds[0] });
    assert.ok(info.title, `no title for OSR tab: ${JSON.stringify(info)}`);
    assert.match(info.url, /app=1/);
    // Second tab is independently addressable, not a shadow of the first.
    const other = await json("page_info", { tabId: tabIds[1] });
    assert.match(other.url, /app=2/);

    // Batch-fill a tab that is never attached to the window: the per-tab action queue, the
    // background-tab DOM fallback (a Playwright action would be swallowed here) and fill_form's
    // batching, composed on a real OSR tab. Submitting afterwards proves the values are in the
    // page's own DOM rather than just reported back.
    const osrForm = (await json("forms", { tabId: tabIds[0] }))[0];
    const field = (name) => osrForm.fields.find((f) => f.name === name);
    assert.ok(
      field("name")?.ref && field("color")?.ref && field("agree")?.ref,
      `missing refs on the OSR tab's form: ${JSON.stringify(osrForm.fields)}`,
    );
    const filled = await json("fill_form", {
      tabId: tabIds[0],
      fields: [
        { ref: field("name").ref, value: "Ada in the grid" },
        { ref: field("color").ref, value: "blue" },
        { ref: field("agree").ref, value: "true" },
      ],
    });
    assert.equal(filled.every((r) => r.ok === true), true, JSON.stringify(filled));
    const osrAfter = (await json("forms", { tabId: tabIds[0] }))[0].fields;
    assert.equal(osrAfter.find((f) => f.name === "name")?.value, "Ada in the grid");
    assert.equal(osrAfter.find((f) => f.name === "color")?.value, "blue");
    const submitRef = refOf((await ok("find", { text: "Send form", tabId: tabIds[0] })).text, "the OSR tab's submit button");
    await ok("click", { ref: submitRef, tabId: tabIds[0] });
    await ok("wait_for", { text: "submitted: Ada in the grid", tabId: tabIds[0] });
    assert.match((await ok("get_text", { tabId: tabIds[0] })).text, /submitted: Ada in the grid \/ blue/);

    // screenshot/watch need an attached BrowserView, and the grid detaches every ordinary tab's.
    // Before this refused up front they ran the capture anyway and took ~14 s and ~15 s to fail
    // with a bare "Timed out after 6000ms"; the session's own tabs still photograph fine.
    const t0 = Date.now();
    const refusedShot = await call("screenshot", {});
    assert.equal(refusedShot.isError, true, "screenshot on a regular tab should refuse during a session");
    assert.match(refusedShot.text, /applications grid session is open/);
    assert.ok(Date.now() - t0 < 5000, `screenshot should refuse immediately, took ${Date.now() - t0}ms`);
    const refusedWatch = await call("watch", { durationMs: 800 });
    assert.equal(refusedWatch.isError, true, "watch on a regular tab should refuse during a session");
    assert.match(refusedWatch.text, /applications grid session is open/);
    assert.equal((await call("screenshot", { tabId: tabIds[0] })).isError, undefined, "an OSR tab still photographs");

    // tabs_select cannot move focus while the grid is up, so it must say so rather than
    // reporting a move that never happened.
    const selectDuring = await call("tabs_select", { id: before[0].id });
    assert.equal(selectDuring.isError, true, "tabs_select should refuse while the grid is open");
    assert.match(selectDuring.text, /applications grid session is open/);
    const selectOsr = await call("tabs_select", { id: tabIds[0] });
    assert.equal(selectOsr.isError, true, "tabs_select should refuse an OSR tab");
    assert.match(selectOsr.text, /renders in the applications grid/);

    // tabs_list flags OSR tabs so the grid can tell them from ordinary tabs.
    const duringSession = await json("tabs_list");
    for (const id of tabIds) {
      assert.equal(duringSession.find((t) => t.id === id)?.osr, true, `${id} should be osr`);
    }
    assert.equal(duringSession.find((t) => !tabIds.includes(t.id))?.osr, false);

    // Closing the active tab while a session is open must fall back to a real tab. OSR tabs
    // sit at the end of the strip order but can never be attached, so picking "the last tab"
    // blindly would refuse and leave the window without a view.
    const extra = await ok("tabs_new", { url: `${FX}/index.html` });
    const extraId = /tab-\d+/.exec(extra.text)?.[0];
    assert.ok(extraId, `no tab id in "${extra.text}"`);
    await ok("tabs_close", { id: extraId });

    // One session at a time, and no more than six tabs in it.
    const second = await call("apps_session_start", { urls: [`${FX}/index.html`] });
    assert.equal(second.isError, true, "a second concurrent session should be refused");
    const tooMany = await call("apps_session_start", {
      urls: Array.from({ length: 7 }, () => `${FX}/index.html`),
    });
    assert.equal(tooMany.isError, true, "more than 6 urls should be refused");

    await ok("apps_session_end", {});
    const remaining = (await json("tabs_list")).map((t) => t.id);
    for (const id of tabIds) {
      assert.equal(remaining.includes(id), false, `${id} survived apps_session_end`);
    }
    assert.equal(remaining.length, before.length);

    // Ending a session leaves no session behind, so the next one starts cleanly.
    const reopened = await json("apps_session_start", { urls: [`${FX}/index.html`] });
    assert.equal(reopened.tabIds.length, 1);
    await ok("apps_session_end", {});
  });

  await check("apps_session_end close:false keeps the tabs open, addressable, and flagged osr", async () => {
    const { tabIds } = await json("apps_session_start", { urls: [`${FX}/forms.html?kept=1`] });
    const kept = tabIds[0];
    await ok("wait_for", { text: "Form fixture", tabId: kept });

    await ok("apps_session_end", { close: false });

    // The tab is still open, still an OSR tab (so the grid keeps showing it), and still
    // driveable by tabId — "ending the session" only stops the cap/one-at-a-time tracking.
    const listed = (await json("tabs_list")).find((t) => t.id === kept);
    assert.ok(listed, `${kept} should still be open after apps_session_end close:false`);
    assert.equal(listed.osr, true, "a kept tab stays an OSR tab");
    assert.match((await json("page_info", { tabId: kept })).url, /kept=1/);

    // Tracking really was released: a fresh batch can start even though the old tab lives on.
    const next = await json("apps_session_start", { urls: [`${FX}/index.html`] });
    assert.equal(next.tabIds.length, 1);
    assert.notEqual(next.tabIds[0], kept);

    // Ending that session must not touch the untracked tab it no longer owns.
    await ok("apps_session_end", {});
    assert.ok(
      (await json("tabs_list")).some((t) => t.id === kept),
      "apps_session_end closed a tab that was no longer part of the session",
    );
    await ok("tabs_close", { id: kept });
  });

  await check("cross-tab concurrency: overlapping type/find never clobber another tab's refs", async () => {
    // Two tabs on the same fixture shape (like two job-application forms open side by side),
    // distinguished by query string so they are genuinely different navigations.
    const openedA = await ok("tabs_new", { url: `${FX}/forms.html?tab=a` });
    const idA = /tab-\d+/.exec(openedA.text)?.[0];
    assert.ok(idA, `no tab id in "${openedA.text}"`);
    const openedB = await ok("tabs_new", { url: `${FX}/forms.html?tab=b` });
    const idB = /tab-\d+/.exec(openedB.text)?.[0];
    assert.ok(idB, `no tab id in "${openedB.text}"`);

    await ok("wait_for", { text: "Form fixture", tabId: idA });
    await ok("wait_for", { text: "Form fixture", tabId: idB });

    const findRefOnTab = async (tabId, label) => {
      const found = await ok("find", { label, tabId });
      return refOf(found.text, `${label} field on ${tabId}`);
    };
    const nameRefA = await findRefOnTab(idA, "Name");
    const nameRefB = await findRefOnTab(idB, "Name");

    // Fire both `type` calls without awaiting the first: the per-tab queue (not one global
    // lock) must let A and B run concurrently while keeping each tab's own DOM untouched by
    // the other.
    const typeA = ok("type", { ref: nameRefA, text: "Ada TabA", tabId: idA });
    const typeB = ok("type", { ref: nameRefB, text: "Grace TabB", tabId: idB });
    await Promise.all([typeA, typeB]);

    const nameValue = (forms) => forms[0]?.fields.find((f) => f.name === "name")?.value;
    assert.equal(nameValue(await json("forms", { tabId: idA })), "Ada TabA", "tab A's own value");
    assert.equal(nameValue(await json("forms", { tabId: idB })), "Grace TabB", "tab B's own value");

    const submitRefA = refOf((await ok("find", { text: "Send form", tabId: idA })).text, "submit button on tab A");

    // A fresh `find` on tab B rebuilds ITS OWN snapshotByRef map. If refs were kept in one
    // shared place instead of per tab, this would invalidate or silently repoint tab A's ref.
    await ok("find", { label: "Color", tabId: idB });

    await ok("click", { ref: submitRefA, tabId: idA });
    await ok("wait_for", { text: "submitted: Ada TabA", tabId: idA });

    // Tab B was never submitted and still shows its own typed value, untouched by tab A's click.
    assert.equal(nameValue(await json("forms", { tabId: idB })), "Grace TabB", "tab B still holds its own value");
    const outB = await ok("get_text", { tabId: idB });
    assert.doesNotMatch(outB.text, /submitted/, "tab B must not show tab A's submission");

    await ok("tabs_close", { id: idA });
    await ok("tabs_close", { id: idB });
  });

  await check("cross-tab: Enter submits a background tab (type submit:true, and press)", async () => {
    // A third "front" tab stays active for the whole check, so A and B are both genuinely
    // background tabs throughout -- the DOM-script fallback path a synthetic KeyboardEvent
    // alone can't submit through without the requestSubmit() step.
    const openedA = await ok("tabs_new", { url: `${FX}/forms.html?tab=enter-a` });
    const idA = /tab-\d+/.exec(openedA.text)?.[0];
    assert.ok(idA, `no tab id in "${openedA.text}"`);
    const openedB = await ok("tabs_new", { url: `${FX}/forms.html?tab=enter-b` });
    const idB = /tab-\d+/.exec(openedB.text)?.[0];
    assert.ok(idB, `no tab id in "${openedB.text}"`);
    const openedFront = await ok("tabs_new", { url: `${FX}/index.html` });
    const idFront = /tab-\d+/.exec(openedFront.text)?.[0];
    assert.ok(idFront, `no tab id in "${openedFront.text}"`);

    await ok("wait_for", { text: "Form fixture", tabId: idA });
    await ok("wait_for", { text: "Form fixture", tabId: idB });

    // type(..., submit: true) on a background tab.
    const nameRefA = refOf((await ok("find", { label: "Name", tabId: idA })).text, "Name field on tab A");
    await ok("type", { ref: nameRefA, text: "Typed Submit", submit: true, tabId: idA });
    await ok("wait_for", { text: "submitted: Typed Submit", tabId: idA });

    // type(..., submit: false) then a separate press("Enter") on a background tab.
    const nameRefB = refOf((await ok("find", { label: "Name", tabId: idB })).text, "Name field on tab B");
    await ok("type", { ref: nameRefB, text: "Pressed Submit", tabId: idB });
    await ok("press", { key: "Enter", tabId: idB });
    await ok("wait_for", { text: "submitted: Pressed Submit", tabId: idB });

    await ok("tabs_close", { id: idA });
    await ok("tabs_close", { id: idB });
    await ok("tabs_close", { id: idFront });
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

  await check("captcha_check on a clean page", async () => {
    await ok("navigate", { url: `${FX}/index.html` });
    assert.equal(JSON.parse((await ok("captcha_check")).text).present, false);
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

  // `evaluate` is enabled by default in this harness (see TOTAL_TOOLS above), so no gating
  // is needed here — other checks in this file (e.g. "zoom + keyboard_shortcut + evaluate")
  // call it unconditionally too. Clicks the "hover me" button rather than a nav link so the
  // clicked element is still on the page afterward to check the cursor's position against.
  await check("click leaves a cursor overlay element positioned near the clicked element", async () => {
    await ok("navigate", { url: `${FX}/index.html` });
    const ref = await findRef({ text: "hover me" });
    await ok("click", { ref });
    const box = await json("evaluate", {
      js: `(() => {
        const c = document.getElementById('__echo_cursor__');
        const t = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
        if (!c || !t) return null;
        const cx = parseFloat(c.style.left);
        const cy = parseFloat(c.style.top);
        const r = t.getBoundingClientRect();
        return {
          opacity: c.style.opacity,
          nearX: Math.abs(cx - (r.left + r.width / 2)) < 5,
          nearY: Math.abs(cy - (r.top + r.height / 2)) < 5,
        };
      })()`,
    });
    assert.ok(box, "cursor overlay element not found after click");
    assert.equal(box.opacity, "1");
    assert.equal(box.nearX, true, `cursor x not near target: ${JSON.stringify(box)}`);
    assert.equal(box.nearY, true, `cursor y not near target: ${JSON.stringify(box)}`);
  });

  await check("every tool exercised", () => {
    const missed = names.filter((n) => !called.has(n) && !SKIPPED.has(n));
    assert.deepEqual(missed, [], `never called: ${missed.join(", ")}`);
    const strays = [...called].filter((n) => SKIPPED.has(n));
    assert.deepEqual(strays, [], `called a skipped tool: ${strays.join(", ")}`);
    console.log(`     ${called.size} of ${names.length} tools called (skipped: ${[...SKIPPED].join(", ")})`);
  });

  await cdp.close();
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
