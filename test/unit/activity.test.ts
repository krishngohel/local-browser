import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityLog } from "../../src/main/activity";

test("wrap records ok/err entries with timing and caps recent at 20", async () => {
  const log = new ActivityLog();
  const ok = log.wrap("navigate", () => "cursor", async (a: { url: string }) => ({ content: [{ type: "text", text: `Navigated to ${a.url}` }] }));
  const bad = log.wrap("click", () => "cursor", async () => { throw new Error("boom"); });
  await ok({ url: "https://a" });
  const r = await bad(undefined as never);
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /boom/);
  for (let i = 0; i < 28; i++) await ok({ url: "x" });
  await bad(undefined as never);
  await ok({ url: "x" });
  const s = log.state();
  assert.equal(s.count, 32);
  assert.equal(s.recent.length, 20);
  assert.equal(s.recent[0].tool, "navigate");
  assert.equal(s.running, null);
  assert.ok(s.recent.some((e) => e.ok === false && e.tool === "click"));
});

test("paused short-circuits without running the handler", async () => {
  const log = new ActivityLog();
  let ran = false;
  const fn = log.wrap("snapshot", () => "claude", async () => { ran = true; return { content: [] }; });
  log.setPaused(true);
  const r = await fn(undefined as never);
  assert.equal(ran, false);
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /paused/i);
  log.setPaused(false);
  await fn(undefined as never);
  assert.equal(ran, true);
});
