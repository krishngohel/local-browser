import fs from "node:fs";
import path from "node:path";

/**
 * Interval replay of saved recordings, for as long as Echo is open.
 *
 * This is deliberately not a cron: schedules are "every N minutes from when you added it",
 * they only fire while the app runs, and a missed window is simply skipped rather than
 * queued up. Pure Node — the directory is passed in — so it unit-tests without Electron.
 */

export type Schedule = {
  id: string;
  recordingId: string;
  everyMs: number;
  nextRunAt: string;
  lastRunAt: string | null;
  /** The last run's message, trimmed to something a tool response can show. */
  lastResult: string | null;
};

/** Runs one recording. Never rejects in practice — failures come back as `ok: false`. */
export type RunRecording = (recordingId: string) => Promise<{ ok: boolean; message: string }>;

const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;
const RESULT_CAP = 200;
const DEFAULT_INTERVAL_MS = 15000;

export class Scheduler {
  private schedules: Schedule[] = [];
  private file: string;
  private run: RunRecording;
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** One job at a time: a slow replay must not overlap the next tick, or itself. */
  private busy = false;

  constructor(dir: string, run: RunRecording, now: () => number = Date.now) {
    this.file = path.join(dir, "schedules.json");
    this.run = run;
    this.now = now;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Schedule[];
      this.schedules = Array.isArray(raw) ? raw.filter(isSchedule) : [];
    } catch {
      this.schedules = [];
    }
  }

  add(recordingId: string, everyMinutes: number): Schedule {
    const id = recordingId?.trim();
    if (!id) throw new Error("A recording id is required.");
    if (!Number.isInteger(everyMinutes) || everyMinutes < MIN_MINUTES || everyMinutes > MAX_MINUTES) {
      throw new RangeError(
        `everyMinutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}, got ${everyMinutes}.`,
      );
    }
    const everyMs = everyMinutes * 60_000;
    const schedule: Schedule = {
      id: `sch-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      recordingId: id,
      everyMs,
      nextRunAt: new Date(this.now() + everyMs).toISOString(),
      lastRunAt: null,
      lastResult: null,
    };
    this.schedules.push(schedule);
    this.save();
    return { ...schedule };
  }

  list(): Schedule[] {
    return this.schedules.map((s) => ({ ...s }));
  }

  cancel(id: string): boolean {
    const at = this.schedules.findIndex((s) => s.id === id);
    if (at < 0) return false;
    this.schedules.splice(at, 1);
    this.save();
    return true;
  }

  /**
   * Runs every due schedule once, one after another, and moves each one on to its next slot.
   * A tick that arrives while a replay is still going does nothing, so two recordings can
   * never drive the browser at the same time.
   */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = this.schedules.filter((s) => Date.parse(s.nextRunAt) <= this.now());
      for (const job of due) {
        // A schedule cancelled during an earlier replay in this same tick must not run.
        if (!this.schedules.includes(job)) continue;
        let message: string;
        try {
          message = (await this.run(job.recordingId)).message;
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        job.lastRunAt = new Date(this.now()).toISOString();
        job.lastResult = message.slice(0, RESULT_CAP);
        job.nextRunAt = new Date(this.now() + job.everyMs).toISOString();
        this.save();
      }
    } finally {
      this.busy = false;
    }
  }

  /** Idempotent: calling it twice keeps the one timer. */
  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // The scheduler must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.schedules, null, 2) + "\n", "utf8");
    } catch {
      /* best effort */
    }
  }
}

function isSchedule(s: unknown): s is Schedule {
  const v = s as Schedule;
  return (
    Boolean(v) &&
    typeof v.id === "string" &&
    typeof v.recordingId === "string" &&
    typeof v.everyMs === "number" &&
    v.everyMs > 0 &&
    typeof v.nextRunAt === "string"
  );
}
