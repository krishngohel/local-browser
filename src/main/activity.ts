import type { ActivityEntry, ActivityState } from "../shared/types";

const RING = 200;
export const PAUSED_MESSAGE = "Echo is paused by the user. Ask them to resume from the toolbar.";

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private seq = 0;
  private paused = false;
  private running: string | null = null;
  private onChange: () => void = () => {};

  setOnChange(fn: () => void): void { this.onChange = fn; }
  setPaused(p: boolean): void { this.paused = p; this.onChange(); }
  isPaused(): boolean { return this.paused; }
  clear(): void { this.entries = []; this.onChange(); }
  count(): number { return this.seq; }

  state(): ActivityState {
    return { paused: this.paused, count: this.seq, running: this.running, recent: this.entries.slice(-20).reverse() };
  }

  wrap<A, R extends { isError?: boolean; content: unknown[] }>(tool: string, client: () => string, handler: (args: A) => Promise<R>): (args: A) => Promise<R> {
    return async (args: A) => {
      if (this.paused) {
        this.push(tool, client(), 0, false, PAUSED_MESSAGE);
        return { isError: true, content: [{ type: "text", text: PAUSED_MESSAGE }] } as unknown as R;
      }
      const t0 = Date.now();
      this.running = tool;
      this.onChange();
      try {
        const result = await handler(args);
        this.push(tool, client(), Date.now() - t0, !result.isError, summarize(result));
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.push(tool, client(), Date.now() - t0, false, message);
        return { isError: true, content: [{ type: "text", text: message }] } as unknown as R;
      } finally {
        this.running = null;
        this.onChange();
      }
    };
  }

  private push(tool: string, client: string, ms: number, ok: boolean, summary: string): void {
    this.entries.push({ id: ++this.seq, tool, client, startedAt: new Date().toISOString(), ms, ok, summary: summary.slice(0, 160) });
    if (this.entries.length > RING) this.entries = this.entries.slice(-RING);
  }
}

function summarize(result: { content: unknown[] }): string {
  const first = result.content.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined;
  return (first?.text ?? "").split("\n")[0];
}
