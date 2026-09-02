import type { DownloadInfo } from "../shared/types";

export type { DownloadInfo };

const CAP = 100;

/** Structural item type so this module never imports `electron` (unit tests bundle it). */
type TrackedItem = {
  getFilename(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  on(ev: "updated" | "done", cb: (e: unknown, state: string) => void): unknown;
};

export class Downloads {
  private items: DownloadInfo[] = [];
  private seq = 0;

  track(item: TrackedItem, dest: string): void {
    const info: DownloadInfo = {
      id: `dl-${++this.seq}`,
      filename: item.getFilename(),
      path: dest,
      bytes: 0,
      totalBytes: item.getTotalBytes(),
      state: "progressing",
      startedAt: new Date().toISOString(),
    };
    this.items.unshift(info);
    this.items = this.items.slice(0, CAP);
    item.on("updated", () => {
      info.bytes = item.getReceivedBytes();
    });
    item.on("done", (_e, state) => {
      info.bytes = item.getReceivedBytes();
      info.state = state as DownloadInfo["state"];
    });
  }

  list(): DownloadInfo[] {
    return this.items.map((i) => ({ ...i }));
  }
}
