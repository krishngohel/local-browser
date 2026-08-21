import fs from "node:fs";
import path from "node:path";
import type { BrowserHub } from "./browser";
import { recordingsDir } from "./paths";
import type {
  PlayResult,
  RecordedAction,
  RecordingFile,
  RecordingInfo,
  RecordingState,
} from "../shared/types";

export class Recorder {
  private current: RecordingFile | null = null;
  private playing = false;
  private ignoreDepth = 0;
  private lastRecordAt = 0;
  private onChange: () => void = () => {};

  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  isRecording(): boolean {
    return Boolean(this.current);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  isIgnoring(): boolean {
    return this.ignoreDepth > 0 || this.playing;
  }

  beginIgnore(): void {
    this.ignoreDepth += 1;
  }

  endIgnore(): void {
    this.ignoreDepth = Math.max(0, this.ignoreDepth - 1);
  }

  endIgnoreSoon(ms = 250): void {
    setTimeout(() => this.endIgnore(), ms);
  }

  snapshot(): RecordingState {
    return {
      active: Boolean(this.current),
      playing: this.playing,
      name: this.current?.name ?? null,
      actionCount: this.current?.actions.length ?? 0,
      recordings: this.list(),
    };
  }

  start(name?: string, startUrl?: string): RecordingState {
    if (this.current) throw new Error("Already recording. Stop the current recording first.");
    if (this.playing) throw new Error("Can't record while a recording is playing.");
    const now = new Date();
    this.current = {
      id: `rec-${now.getTime().toString(36)}`,
      name: name?.trim() || defaultName(now),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      actions: [],
    };
    if (startUrl) this.record({ type: "navigate", url: startUrl });
    this.onChange();
    return this.snapshot();
  }

  stop(): RecordingFile | null {
    if (!this.current) return null;
    const rec = this.current;
    rec.updatedAt = new Date().toISOString();
    this.write(rec);
    this.current = null;
    this.onChange();
    return rec;
  }

  record(action: RecordedAction): void {
    if (!this.current || this.playing) return;
    const actions = this.current.actions;
    const last = actions[actions.length - 1];
    const now = Date.now();
    if (last && last.type === "type" && action.type === "type" && sameSelectors(last.selectors, action.selectors)) {
      actions[actions.length - 1] = action;
    } else if (last && last.type === "scroll" && action.type === "scroll") {
      last.deltaY += action.deltaY;
    } else if (
      last &&
      last.type === "click" &&
      action.type === "click" &&
      sameSelectors(last.selectors, action.selectors) &&
      now - this.lastRecordAt < 500
    ) {
      return;
    } else {
      actions.push(action);
    }
    this.lastRecordAt = now;
    this.current.updatedAt = new Date().toISOString();
    this.write(this.current);
    this.onChange();
  }

  list(): RecordingInfo[] {
    const dir = recordingsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const items: RecordingInfo[] = [];
    for (const file of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as RecordingFile;
        if (this.current && rec.id === this.current.id) {
          rec.actions = this.current.actions;
          rec.name = this.current.name;
        }
        items.push({
          id: rec.id,
          name: rec.name,
          createdAt: rec.createdAt,
          actionCount: rec.actions?.length ?? 0,
        });
      } catch {
        /* skip corrupt */
      }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  load(id: string): RecordingFile {
    if (this.current?.id === id) return this.current;
    const file = path.join(recordingsDir(), `${id}.json`);
    if (!fs.existsSync(file)) throw new Error(`Unknown recording ${id}`);
    return JSON.parse(fs.readFileSync(file, "utf8")) as RecordingFile;
  }

  delete(id: string): void {
    if (this.current?.id === id) {
      this.current = null;
    }
    const file = path.join(recordingsDir(), `${id}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.onChange();
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Name cannot be empty");
    if (this.current?.id === id) {
      this.current.name = trimmed;
      this.write(this.current);
      this.onChange();
      return;
    }
    const rec = this.load(id);
    rec.name = trimmed;
    rec.updatedAt = new Date().toISOString();
    this.write(rec);
    this.onChange();
  }

  async play(id: string, hub: BrowserHub): Promise<PlayResult> {
    return this.playRange(id, 0, undefined, hub);
  }

  /**
   * Plays a slice of a recording: `from` is a 0-based inclusive step index, `to` is
   * exclusive and defaults to the end. A slice outside the recording throws, the same way
   * an unknown id does, so the caller reports it rather than silently playing nothing.
   */
  async playRange(id: string, from: number, to: number | undefined, hub: BrowserHub): Promise<PlayResult> {
    if (this.current) throw new Error("Stop recording before playing a recording.");
    if (this.playing) throw new Error("A recording is already playing.");
    const rec = this.load(id);
    const total = rec.actions.length;
    const start = Number.isInteger(from) ? from : NaN;
    const end = to === undefined ? total : Number.isInteger(to) ? to : NaN;
    if (!(start >= 0) || start >= total) {
      throw new Error(`“${rec.name}” has ${total} step(s); from ${from} is out of range.`);
    }
    if (!(end > start) || end > total) {
      throw new Error(`“${rec.name}” has ${total} step(s); to ${to} is out of range.`);
    }
    const steps = rec.actions.slice(start, end);
    this.playing = true;
    this.onChange();
    try {
      for (let i = 0; i < steps.length; i++) {
        const action = steps[i];
        try {
          await this.run(hub, action);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Stopped at step ${start + i + 1} (${action.type}): ${reason}`);
        }
      }
      return { ok: true, message: `Played “${rec.name}” steps ${start + 1}–${end}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.playing = false;
      this.onChange();
    }
  }

  private async run(hub: BrowserHub, action: RecordedAction): Promise<void> {
    switch (action.type) {
      case "navigate":
        await hub.navigate(action.url);
        await hub.waitFor({ timeoutMs: 15000, record: false });
        await sleep(350);
        return;
      case "newTab":
        hub.createTab(action.url);
        await hub.waitFor({ timeoutMs: 15000, record: false });
        await sleep(350);
        return;
      case "selectTab": {
        const tabs = hub.listTabs();
        const match =
          tabs.find((tab) => tab.url === action.url) ||
          (action.title ? tabs.find((tab) => tab.title === action.title) : undefined);
        if (match) hub.selectTab(match.id, { record: false });
        await sleep(150);
        return;
      }
      case "back":
        hub.back();
        await hub.waitFor({ timeoutMs: 10000, record: false });
        return;
      case "forward":
        hub.forward();
        await hub.waitFor({ timeoutMs: 10000, record: false });
        return;
      case "reload":
        hub.reload();
        await hub.waitFor({ timeoutMs: 15000, record: false });
        return;
      case "click":
        await hub.clickSelectors(action.selectors, action.text);
        await sleep(250);
        try {
          await hub.waitFor({ timeoutMs: 5000, record: false });
        } catch {
          /* already idle */
        }
        return;
      case "hover":
        await hub.hoverSelectors(action.selectors);
        await sleep(200);
        return;
      case "type":
        await hub.typeSelectors(action.selectors, action.text, Boolean(action.submit), action.name);
        await sleep(120);
        return;
      case "press":
        await hub.press(action.key);
        return;
      case "scroll":
        await hub.scroll(action.deltaY);
        return;
      case "select":
        await hub.selectSelectors(action.selectors, action.value);
        return;
      case "wait":
        await hub.waitFor({ text: action.text, timeoutMs: action.ms ?? 10000, record: false });
        return;
      default:
        return;
    }
  }

  private write(rec: RecordingFile): void {
    const dest = path.join(recordingsDir(), `${rec.id}.json`);
    fs.writeFileSync(dest, JSON.stringify(rec, null, 2) + "\n", "utf8");
  }
}

function sameSelectors(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function defaultName(now: Date): string {
  return `Recording ${now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
