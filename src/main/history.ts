import fs from "node:fs";
import path from "node:path";
import type { HistoryEntry } from "../shared/types";

export type { HistoryEntry };

const CAP = 5000;

export class History {
  private entries: HistoryEntry[] = [];
  private file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "history.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as HistoryEntry[];
      this.entries = Array.isArray(raw) ? raw.filter(isEntry) : [];
    } catch {
      this.entries = [];
    }
  }

  add(url: string, title: string): void {
    if (!/^https?:/.test(url)) return;
    const last = this.entries[this.entries.length - 1];
    if (last && last.url === url) {
      last.visitedAt = new Date().toISOString();
      this.save();
      return;
    }
    this.entries.push({ url, title: title || url, visitedAt: new Date().toISOString() });
    if (this.entries.length > CAP) this.entries = this.entries.slice(-CAP);
    this.save();
  }

  updateTitle(url: string, title: string): void {
    if (!title) return;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].url === url) {
        this.entries[i].title = title;
        break;
      }
    }
    this.save();
  }

  /** Most recent first, one row per url. An empty query returns recent history. */
  search(q: string, limit = 20): HistoryEntry[] {
    const needle = q.trim().toLowerCase();
    const seen = new Set<string>();
    const out: HistoryEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (seen.has(e.url)) continue;
      if (!needle || e.url.toLowerCase().includes(needle) || e.title.toLowerCase().includes(needle)) {
        seen.add(e.url);
        out.push(e);
      }
    }
    return out;
  }

  all(): HistoryEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.save();
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries));
    } catch {
      /* best effort */
    }
  }
}

function isEntry(e: unknown): e is HistoryEntry {
  return Boolean(e) && typeof (e as HistoryEntry).url === "string" && typeof (e as HistoryEntry).title === "string";
}
