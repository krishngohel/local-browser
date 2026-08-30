import { test } from "node:test";
import assert from "node:assert/strict";
import { DialogPolicies } from "../../src/main/dialogs";
import { dispatchKeyScript, keyChordScript, mouseEventScript, parseChord } from "../../src/main/page-scripts";

test("dialog policy defaults to dismiss and is per tab", () => {
  const policies = new DialogPolicies();
  assert.deepEqual(policies.get("t1"), { action: "dismiss" });
  policies.set("t1", { action: "accept", promptText: "hello" });
  assert.deepEqual(policies.get("t1"), { action: "accept", promptText: "hello" });
  assert.deepEqual(policies.get("t2"), { action: "dismiss" }, "other tabs are unaffected");
});

test("dialog policy drops an unknown action back to dismiss", () => {
  const policies = new DialogPolicies();
  policies.set("t1", { action: "nope" as unknown as "accept" });
  assert.equal(policies.get("t1").action, "dismiss");
});

test("last dialog seen is remembered per tab and forgotten with the tab", () => {
  const policies = new DialogPolicies();
  assert.equal(policies.last("t1"), null);
  policies.note("t1", { type: "alert", message: "hi", handledAs: "dismiss", at: "2026-01-01T00:00:00.000Z" });
  assert.equal(policies.last("t1")?.message, "hi");
  assert.equal(policies.last("t2"), null);
  policies.forget("t1");
  assert.equal(policies.last("t1"), null);
});

test("parseChord splits modifiers from the final key", () => {
  assert.deepEqual(parseChord("Control+Shift+P"), { key: "P", ctrl: true, shift: true, alt: false, meta: false });
  assert.deepEqual(parseChord("Enter"), { key: "Enter", ctrl: false, shift: false, alt: false, meta: false });
  assert.deepEqual(parseChord("ctrl+a"), { key: "a", ctrl: true, shift: false, alt: false, meta: false });
  assert.deepEqual(parseChord("Meta+Alt+ArrowLeft"), {
    key: "ArrowLeft",
    ctrl: false,
    shift: false,
    alt: true,
    meta: true,
  });
  // Aliases, and a chord whose key is "+" itself.
  assert.equal(parseChord("Cmd+k").meta, true);
  assert.equal(parseChord("ControlOrMeta+k").ctrl, true);
  assert.deepEqual(parseChord("Control++"), { key: "+", ctrl: true, shift: false, alt: false, meta: false });
});

test("keyChordScript emits the parsed modifier flags", () => {
  const js = keyChordScript("Control+Shift+P");
  assert.match(js, /key: "P"/);
  assert.match(js, /ctrlKey: true/);
  assert.match(js, /shiftKey: true/);
  assert.match(js, /altKey: false/);
  assert.match(js, /metaKey: false/);
});

test("mouseEventScript targets the ref and uses button 2 for contextmenu", () => {
  const hover = mouseEventScript("e3", ["mouseover", "mouseenter"]);
  assert.match(hover, /\[data-lb-ref=\\"e3\\"\]/);
  assert.match(hover, /button: 0/);
  assert.match(mouseEventScript("e3", ["contextmenu"]), /button: 2/);
});

test("dispatchKeyScript dispatches all three key events at the given element", () => {
  const js = dispatchKeyScript("document.activeElement", "Enter");
  assert.match(js, /document\.activeElement/);
  assert.match(js, /new KeyboardEvent\('keydown', init\)/);
  assert.match(js, /new KeyboardEvent\('keypress', init\)/);
  assert.match(js, /new KeyboardEvent\('keyup', init\)/);
  assert.match(js, /key: "Enter"/);
});

test("dispatchKeyScript only approximates submit-on-Enter: skips textarea, requires default not prevented", () => {
  const js = dispatchKeyScript("document.activeElement", "Enter");
  assert.match(js, /el\.tagName !== 'TEXTAREA'/);
  assert.match(js, /notPrevented/);
  assert.match(js, /form\.requestSubmit/);
  assert.match(js, /form\.submit\(\)/);
});

test("dispatchKeyScript does not attempt to submit for a non-Enter key", () => {
  const js = dispatchKeyScript("document.activeElement", "Tab");
  assert.match(js, /key: "Tab"/);
  // The Enter-only submit branch is generated with the literal key baked in, so a non-Enter
  // key's script can never reach it: the JSON-encoded key compared against 'Enter' is 'Tab'.
  assert.match(js, /"Tab" === 'Enter'/);
});
