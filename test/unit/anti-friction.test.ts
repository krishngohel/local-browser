import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanChromeUserAgent } from "../../src/main/user-agent";
import { PACING_MIN_MS, PACING_MAX_MS, pacingDelayMs, pace } from "../../src/main/pacing";
import {
  RateLimiter,
  retryAfterUntil,
  hostOf,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from "../../src/main/rate-limit";

test("cleanChromeUserAgent drops Electron/app tokens and keeps a truthful Chrome UA", () => {
  const win = cleanChromeUserAgent("win32", "126.0.6478.127");
  assert.match(win, /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/);
  assert.match(win, /Chrome\/126\.0\.0\.0 Safari\/537\.36$/);
  assert.ok(!/Electron/i.test(win), "no Electron token");
  assert.ok(!/local-browser|Echo/i.test(win), "no app-name token");
  assert.match(cleanChromeUserAgent("darwin", "126.0.0.0"), /Macintosh; Intel Mac OS X 10_15_7/);
  assert.match(cleanChromeUserAgent("linux", "126.0.0.0"), /X11; Linux x86_64/);
  // A malformed version falls back rather than emitting "Chrome/NaN".
  assert.match(cleanChromeUserAgent("win32", "garbage"), /Chrome\/120\.0\.0\.0/);
});

test("pacingDelayMs stays within the configured range", () => {
  for (const r of [0, 0.5, 1, 0.999]) {
    const ms = pacingDelayMs(() => r);
    assert.ok(ms >= PACING_MIN_MS && ms <= PACING_MAX_MS, `${ms} out of range for rng ${r}`);
  }
});

test("pace resolves immediately when disabled", async () => {
  const start = Date.now();
  await pace(false, () => 1);
  assert.ok(Date.now() - start < 40, "disabled pacing should not sleep");
});

test("hostOf and retryAfterUntil parse what servers actually send", () => {
  assert.equal(hostOf("https://Example.com/a/b?q=1"), "example.com");
  assert.equal(hostOf("not a url"), "");
  const now = 1_000_000;
  assert.equal(retryAfterUntil("120", now), now + 120_000, "delta-seconds");
  assert.equal(retryAfterUntil(undefined, now), null);
  assert.equal(retryAfterUntil("nonsense", now), null);
  const date = retryAfterUntil("Wed, 21 Oct 2099 07:28:00 GMT", now);
  assert.ok(date && date > now, "http-date parses to a future deadline");
});

test("RateLimiter holds then releases a host after its 429 window", () => {
  const rl = new RateLimiter();
  const now = 1_000_000;
  rl.note429("https://api.example.com/x", "2", now);
  assert.equal(rl.waitMsFor("https://api.example.com/y", now), 2000, "waits the Retry-After window");
  assert.equal(rl.waitMsFor("https://api.example.com/y", now + 2000), 0, "clears once the window passes");
  assert.equal(rl.waitMsFor("https://other.example.com/", now), 0, "other hosts are unaffected");
});

test("RateLimiter falls back and caps the wait", () => {
  const rl = new RateLimiter();
  const now = 0;
  rl.note429("https://a.test/", undefined, now);
  assert.equal(rl.waitMsFor("https://a.test/", now), DEFAULT_BACKOFF_MS, "no Retry-After uses the default");
  const rl2 = new RateLimiter();
  rl2.note429("https://b.test/", "99999", now);
  assert.equal(rl2.waitMsFor("https://b.test/", now), MAX_BACKOFF_MS, "a huge Retry-After is capped");
});

test("RateLimiter keeps the stricter of two overlapping holds", () => {
  const rl = new RateLimiter();
  const now = 0;
  rl.note429("https://c.test/", "5", now);
  rl.note429("https://c.test/", "2", now);
  assert.equal(rl.waitMsFor("https://c.test/", now), 5000, "a shorter later window does not shorten the hold");
});
