import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { History } from "../../src/main/history";

test("history adds, dedupes consecutive, searches by url/title, persists, caps at 5000", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-hist-"));
  const h = new History(dir);
  h.add("https://example.com/a", "Example A");
  h.add("https://example.com/a", "Example A"); // same url twice in a row -> one entry
  h.add("https://news.site/x", "News");
  h.updateTitle("https://news.site/x", "Big News");
  assert.equal(h.all().length, 2);
  assert.equal(h.search("big")[0].title, "Big News");
  assert.equal(h.search("example.com").length, 1);
  const h2 = new History(dir);
  assert.equal(h2.all().length, 2);
  for (let i = 0; i < 5100; i++) h2.add(`https://x/${i}`, String(i));
  assert.equal(h2.all().length, 5000);
});
