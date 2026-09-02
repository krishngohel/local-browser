import fs from "node:fs";
import path from "node:path";
import type { BookmarkInfo } from "../shared/types";

export type { BookmarkInfo };

export class Bookmarks {
  private entries: BookmarkInfo[] = [];
  private file: string;
  private seq = 0;

  constructor(dir: string) {
    this.file = path.join(dir, "bookmarks.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as BookmarkInfo[];
      this.entries = Array.isArray(raw) ? raw.filter(isBookmark) : [];
    } catch {
      this.entries = [];
    }
  }

  list(): BookmarkInfo[] {
    return this.entries.map((b) => ({ ...b }));
  }

  /**
   * Idempotent per url: bookmarking the same page twice returns the first entry.
   * Returns null for anything that is not an http(s) page, so a blank or internal
   * url can never be stored as an empty bookmark.
   */
  add(url: string, title: string): BookmarkInfo | null {
    if (!/^https?:\/\//.test(url)) return null;
    const existing = this.entries.find((b) => b.url === url);
    if (existing) return { ...existing };
    const entry: BookmarkInfo = {
      id: `bm-${Date.now().toString(36)}-${++this.seq}`,
      url,
      title: title || url,
      createdAt: new Date().toISOString(),
    };
    this.entries.unshift(entry);
    this.save();
    return { ...entry };
  }

  remove(idOrUrl: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((b) => b.id !== idOrUrl && b.url !== idOrUrl);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  has(url: string): boolean {
    return this.entries.some((b) => b.url === url);
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2) + "\n", "utf8");
    } catch {
      /* best effort */
    }
  }
}

function isBookmark(b: unknown): b is BookmarkInfo {
  return Boolean(b) && typeof (b as BookmarkInfo).id === "string" && typeof (b as BookmarkInfo).url === "string";
}
