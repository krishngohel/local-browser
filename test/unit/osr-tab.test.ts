import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Walks up from the bundled test file until it finds the repo root (the one with package.json). */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`Could not find the repo root from ${__dirname}`);
}

/** The body of `createOsrTab`, from its signature to the closing brace of the method. */
function createOsrTabBody(): string {
  const src = fs.readFileSync(path.join(repoRoot(), "src", "main", "browser.ts"), "utf8");
  const start = src.indexOf("private createOsrTab(");
  assert.notEqual(start, -1, "createOsrTab is gone from browser.ts");
  const end = src.indexOf("\n  }", start);
  assert.notEqual(end, -1, "could not find the end of createOsrTab");
  return src.slice(start, end);
}

/**
 * `app.quit()` closes each window with `close()`, which runs the page's `beforeunload`. A page
 * that vetoes unload — job application forms routinely do — cancels that close and aborts the
 * whole quit unless something calls `preventDefault()` on `will-prevent-unload`. Verified
 * against Electron 36.9.5: without this listener `app.quit()` never completes, and because an
 * OSR tab has no visible window, the user just sees Quit doing nothing.
 *
 * This is a source-level guard rather than a behavioural one because the unit test bundle
 * marks `electron` external, so there is no `BrowserWindow` here to construct, and the tool
 * e2e harness cannot exercise it either: `closeTab` destroys an OSR window (bypassing
 * `beforeunload` entirely) and triggering a real `app.quit()` would kill the test run. The
 * behaviour itself was verified out-of-band with a standalone Electron probe.
 */
test("createOsrTab lets the app quit even when the page vetoes unload", () => {
  const body = createOsrTabBody();
  assert.match(
    body,
    /will-prevent-unload/,
    "createOsrTab must handle will-prevent-unload or a beforeunload page will block app.quit()",
  );
  assert.match(
    body,
    /on\("will-prevent-unload",\s*\(\s*event\s*\)\s*=>\s*event\.preventDefault\(\)\)/,
    "the will-prevent-unload handler must call preventDefault() to allow the close",
  );
});

/** OSR tabs are hidden windows, so they must never be handed to `addBrowserView`. */
test("createOsrTab never attaches its window to the main window", () => {
  const body = createOsrTabBody();
  assert.equal(body.includes("addBrowserView"), false, "an OSR tab must never be attached");
});
