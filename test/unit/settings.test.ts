import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, getSettings, setSettings } from "../../src/main/settings";

test("settings default and persist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-settings-"));
  assert.deepEqual(getSettings(dir), DEFAULT_SETTINGS);
  const next = setSettings({ theme: "dark", compactChrome: true }, dir);
  assert.equal(next.theme, "dark");
  assert.equal(getSettings(dir).compactChrome, true);
  assert.equal(getSettings(dir).homeUrl, "https://www.google.com/");
  // invalid values are ignored
  setSettings({ theme: "neon" as never, homeUrl: 42 as never }, dir);
  assert.equal(getSettings(dir).theme, "dark");
});
