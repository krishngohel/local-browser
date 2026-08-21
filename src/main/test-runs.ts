import fs from "node:fs";
import path from "node:path";
import type { TestRunInfo } from "../shared/types";
import { runsDir } from "./paths";
import type { BrowserHub } from "./browser";

export type AssertionResult = {
  ok: boolean;
  message: string;
};

type RunRecord = {
  id: string;
  dir: string;
  startedAt: string;
  assertions: { name: string; ok: boolean; message: string; at: string }[];
  tracing: boolean;
};

export class TestRunner {
  private run: RunRecord | null = null;

  constructor(private readonly hub: BrowserHub) {}

  info(): TestRunInfo {
    if (!this.run) {
      return { id: null, startedAt: null, assertions: 0, failures: 0, dir: null };
    }
    return {
      id: this.run.id,
      startedAt: this.run.startedAt,
      assertions: this.run.assertions.length,
      failures: this.run.assertions.filter((a) => !a.ok).length,
      dir: this.run.dir,
    };
  }

  async start(): Promise<string> {
    if (this.run) {
      await this.end();
    }
    const startedAt = new Date().toISOString();
    const id = startedAt.replace(/[:.]/g, "-");
    const dir = path.join(runsDir(), id);
    fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
    this.run = { id, dir, startedAt, assertions: [], tracing: false };
    await this.hub.screenshot(path.join(dir, "screenshots", "start.png")).catch(() => undefined);
    this.run.tracing = await this.hub.startTracing(path.join(dir, "trace.zip"));
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(this.report(), null, 2));
    return dir;
  }

  async assertText(text: string): Promise<AssertionResult> {
    this.requireRun();
    const haystack = await this.hub.pageText();
    const ok = haystack.toLowerCase().includes(text.toLowerCase());
    return this.record("assert_text", ok, ok ? `Found text: ${text}` : `Text not found: ${text}`);
  }

  async assertUrl(pattern: string): Promise<AssertionResult> {
    this.requireRun();
    const url = this.hub.activeUrl();
    let ok = url.includes(pattern);
    try {
      ok = new RegExp(pattern).test(url);
    } catch {
      ok = url.includes(pattern);
    }
    return this.record("assert_url", ok, ok ? `URL matches ${pattern}` : `URL ${url} does not match ${pattern}`);
  }

  /**
   * The assertion sink for the QA tools. Those tools are useful on their own — a bare
   * `assert_visible` during exploration is a legitimate question — so this records into the
   * run's report when one is open and otherwise just answers, rather than demanding a run.
   */
  assertGeneric(name: string, ok: boolean, message: string): AssertionResult {
    if (!this.run) return { ok, message };
    return this.record(name, ok, message);
  }

  async end(): Promise<string> {
    this.requireRun();
    const dir = this.run!.dir;
    if (this.run!.tracing) {
      await this.hub.stopTracing();
    }
    await this.hub.screenshot(path.join(dir, "screenshots", "end.png")).catch(() => undefined);
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(this.report(), null, 2));
    this.run = null;
    return dir;
  }

  private record(name: string, ok: boolean, message: string): AssertionResult {
    this.run!.assertions.push({
      name,
      ok,
      message,
      at: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(this.run!.dir, "report.json"), JSON.stringify(this.report(), null, 2));
    return { ok, message };
  }

  private report() {
    return {
      id: this.run?.id,
      startedAt: this.run?.startedAt,
      dir: this.run?.dir,
      assertions: this.run?.assertions ?? [],
      failures: this.run?.assertions.filter((a) => !a.ok).length ?? 0,
    };
  }

  private requireRun(): void {
    if (!this.run) {
      throw new Error("No test run is active. Call test_start first.");
    }
  }
}
