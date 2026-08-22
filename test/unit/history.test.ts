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
  h.flush(); // writes are debounced, so force the queued one out before reading from disk
  const h2 = new History(dir);
  assert.equal(h2.all().length, 2);
  for (let i = 0; i < 5100; i++) h2.add(`https://x/${i}`, String(i));
  assert.equal(h2.all().length, 5000);
});

test("history writes are debounced: a burst of adds is one write, flush persists it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-hist-debounce-"));
  const file = path.join(dir, "history.json");
  const h = new History(dir);
  h.add("https://a.test/1", "One");
  h.add("https://b.test/2", "Two");
  // Nothing has touched the disk yet: both adds are sitting behind one trailing timer.
  assert.equal(fs.existsSync(file), false);
  h.flush();
  assert.deepEqual(
    (JSON.parse(fs.readFileSync(file, "utf8")) as { url: string }[]).map((e) => e.url),
    ["https://a.test/1", "https://b.test/2"],
  );
  // That was the only write the burst produced: with nothing queued, flush is a no-op.
  fs.rmSync(file);
  h.flush();
  assert.equal(fs.existsSync(file), false);
  h.add("https://c.test/3", "Three");
  h.flush();
  assert.equal(new History(dir).all().length, 3);
});
