import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bookmarks } from "../../src/main/bookmarks";

test("bookmarks add/has/remove persist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-bm-"));
  const b = new Bookmarks(dir);
  const one = b.add("https://a.com/", "A");
  assert.equal(b.has("https://a.com/"), true);
  assert.equal(b.add("https://a.com/", "A again").id, one.id); // idempotent per url
  assert.equal(new Bookmarks(dir).list().length, 1);
  assert.equal(b.remove("https://a.com/"), true);
  assert.equal(b.remove("nope"), false);
  assert.equal(b.list().length, 0);
});
