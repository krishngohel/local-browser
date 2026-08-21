import { test } from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../../src/main/recordings";
import type { RecordingFile } from "../../src/shared/types";

/**
 * `Recorder` reads and writes through `recordingsDir()`, which needs Electron, so these
 * tests stub `load` to keep the range logic on its own. Nothing here touches the disk or
 * the hub, because a zero-step slice never runs an action.
 */
function emptyRecorder(name: string): Recorder {
  const rec = new Recorder();
  const file: RecordingFile = { id: "rec-0", name, createdAt: "", updatedAt: "", actions: [] };
  (rec as unknown as { load: (id: string) => RecordingFile }).load = () => file;
  return rec;
}

test("play on a recording with no steps is a no-op, not a failure", async () => {
  const rec = emptyRecorder("Empty");
  assert.deepEqual(await rec.play("rec-0", {} as never), {
    ok: true,
    message: "Played “Empty” (0 steps)",
  });
});

test("an explicit range against an empty recording is still out of range", async () => {
  const rec = emptyRecorder("Empty");
  await assert.rejects(() => rec.playRange("rec-0", 0, 1, {} as never), /out of range/);
  await assert.rejects(() => rec.playRange("rec-0", 1, undefined, {} as never), /out of range/);
});
