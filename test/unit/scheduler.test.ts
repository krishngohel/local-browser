import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../src/main/scheduler";

test("schedules persist, run when due, and advance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-sched-"));
  let now = 1_000_000;
  const runs: string[] = [];
  const s = new Scheduler(dir, async (id) => { runs.push(id); return { ok: true, message: "done" }; }, () => now);
  const job = s.add("rec-1", 5);
  assert.equal(job.everyMs, 5 * 60_000);
  await s.tick();
  assert.deepEqual(runs, []);
  now += 5 * 60_000 + 1;
  await s.tick();
  assert.deepEqual(runs, ["rec-1"]);
  assert.equal(s.list()[0].lastResult, "done");
  const reloaded = new Scheduler(dir, async () => ({ ok: true, message: "" }), () => now);
  assert.equal(reloaded.list().length, 1);
  assert.equal(s.cancel(job.id), true);
  assert.equal(s.list().length, 0);
  assert.throws(() => s.add("x", 0));
});

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "echo-sched-"));
}

test("tick never runs two jobs at once", async () => {
  let now = 1_000_000;
  let inFlight = 0;
  let overlaps = 0;
  let release = () => {};
  const s = new Scheduler(
    tmpdir(),
    async () => {
      inFlight += 1;
      if (inFlight > 1) overlaps += 1;
      await new Promise<void>((r) => { release = r; });
      inFlight -= 1;
      return { ok: true, message: "done" };
    },
    () => now,
  );
  s.add("a", 1);
  s.add("b", 1);
  now += 60_001;
  const first = s.tick();
  await new Promise((r) => setImmediate(r));
  // A tick arriving mid-replay is a no-op rather than a second concurrent run.
  await s.tick();
  release();
  await new Promise((r) => setImmediate(r));
  release();
  await first;
  assert.equal(overlaps, 0);
  assert.equal(inFlight, 0);
});

test("a failed run is recorded and the schedule still advances", async () => {
  let now = 1_000_000;
  const s = new Scheduler(tmpdir(), async () => ({ ok: false, message: "x".repeat(500) }), () => now);
  s.add("rec-1", 1);
  now += 60_001;
  await s.tick();
  const job = s.list()[0];
  assert.equal(job.lastResult?.length, 200);
  assert.equal(job.lastRunAt, new Date(now).toISOString());
  assert.equal(job.nextRunAt, new Date(now + 60_000).toISOString());
});

test("a run that throws is caught and recorded", async () => {
  let now = 1_000_000;
  const s = new Scheduler(tmpdir(), async () => { throw new Error("A recording is already playing."); }, () => now);
  s.add("rec-1", 1);
  now += 60_001;
  await s.tick();
  assert.equal(s.list()[0].lastResult, "A recording is already playing.");
});

test("add rejects intervals outside 1..1440 and non-integers", () => {
  const s = new Scheduler(tmpdir(), async () => ({ ok: true, message: "" }));
  assert.throws(() => s.add("r", 0), RangeError);
  assert.throws(() => s.add("r", 1441), RangeError);
  assert.throws(() => s.add("r", 1.5), RangeError);
  assert.throws(() => s.add("", 5));
  assert.equal(s.add("r", 1440).everyMs, 1440 * 60_000);
});

test("cancel reports unknown ids and start/stop are idempotent", () => {
  const s = new Scheduler(tmpdir(), async () => ({ ok: true, message: "" }));
  assert.equal(s.cancel("nope"), false);
  s.start(60_000);
  s.start(60_000);
  s.stop();
  s.stop();
});
