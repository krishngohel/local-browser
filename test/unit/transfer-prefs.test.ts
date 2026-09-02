import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TRANSFER_PREFS, TOOL_GROUP_COUNTS, enabledToolCount, getTransferPrefs, setTransferPrefs, setTransferPrefsDir } from "../../src/main/transfer-prefs";

test("new groups have defaults: read on, others off", () => {
  assert.equal(DEFAULT_TRANSFER_PREFS.toolsRead, true);
  assert.equal(DEFAULT_TRANSFER_PREFS.toolsInteract, false);
  assert.equal(DEFAULT_TRANSFER_PREFS.toolsState, false);
  assert.equal(DEFAULT_TRANSFER_PREFS.toolsQa, false);
});

test("tool counts: legacy defaults = 32 + read 9 = 41; everything + evaluate = 76", () => {
  assert.equal(enabledToolCount({ ...DEFAULT_TRANSFER_PREFS }), 41);
  const all = Object.fromEntries(Object.keys(DEFAULT_TRANSFER_PREFS).map((k) => [k, true])) as typeof DEFAULT_TRANSFER_PREFS;
  assert.equal(enabledToolCount(all, false), 75);
  assert.equal(enabledToolCount(all, true), 76);
  assert.equal(TOOL_GROUP_COUNTS.toolsInteract, 11);
  assert.equal(TOOL_GROUP_COUNTS.toolsState, 14);
});

test("old prefs file without new keys migrates to defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-prefs-"));
  fs.writeFileSync(path.join(dir, "transfer-prefs.json"), JSON.stringify({ toolsBrowse: false }));
  setTransferPrefsDir(dir);
  const prefs = getTransferPrefs();
  assert.equal(prefs.toolsBrowse, false);
  assert.equal(prefs.toolsRead, true);
  assert.equal(prefs.toolsQa, false);
  setTransferPrefs({ toolsQa: true });
  assert.equal(getTransferPrefs().toolsQa, true);
  setTransferPrefsDir(null);
});
