import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearPendingChallenges,
  hasJudgment,
  rememberPendingForTest,
  solveCaptchaOnPage,
  type CaptchaScan,
} from "../../src/main/captcha-solver";
import { setCaptchaSolverPrefs, setCaptchaSolverPrefsDir } from "../../src/main/captcha-solver-prefs";
import type { PwLocator, PwPage } from "../../src/main/pw-bridge";

function emptyLocator(): PwLocator {
  return {
    click: async () => {},
    dblclick: async () => {},
    hover: async () => {},
    fill: async () => {},
    press: async () => {},
    selectOption: async () => {},
    dragTo: async () => {},
    boundingBox: async () => null,
    setInputFiles: async () => {},
    first: () => emptyLocator(),
    nth: () => emptyLocator(),
    count: async () => 0,
    screenshot: async () => Buffer.alloc(0),
    innerText: async () => "",
    isVisible: async () => false,
    getAttribute: async () => null,
  };
}

function mockPage(frames: { url: () => string }[] = []): PwPage {
  return {
    url: () => "https://example.com/",
    locator: () => emptyLocator(),
    frames: () => frames as never,
    mouse: {
      move: async () => {},
      down: async () => {},
      up: async () => {},
    },
    on: () => {},
    waitForEvent: async () => ({ setFiles: async () => {}, isMultiple: () => false }),
    getByText: () => emptyLocator(),
    getByRole: () => emptyLocator(),
    getByPlaceholder: () => emptyLocator(),
    getByLabel: () => emptyLocator(),
    keyboard: { press: async () => {} },
    screenshot: async () => Buffer.alloc(0),
    context: () => ({
      tracing: { start: async () => {}, stop: async () => {} },
      newCDPSession: async () => ({ send: async () => ({}), on: () => {}, detach: async () => {} }),
    }),
  };
}

test("solveCaptchaOnPage reports clean when nothing is present", async () => {
  const result = await solveCaptchaOnPage(mockPage(), { present: false, kind: null, visible: false });
  assert.equal(result.ok, true);
  assert.match(result.message, /No CAPTCHA/i);
});

test("solveCaptchaOnPage hands off invisible score-based checks", async () => {
  const scan: CaptchaScan = { present: true, kind: "recaptcha", visible: false };
  const result = await solveCaptchaOnPage(mockPage(), scan);
  assert.equal(result.ok, false);
  assert.match(result.message, /invisible|score-based/i);
});

test("solveCaptchaOnPage hands off Turnstile and Cloudflare", async () => {
  for (const kind of ["turnstile", "cloudflare"] as const) {
    const result = await solveCaptchaOnPage(mockPage(), { present: true, kind, visible: true });
    assert.equal(result.ok, false, kind);
    assert.match(result.message, /Turnstile|interstitial|cannot be solved/i, kind);
  }
});

test("solveCaptchaOnPage hands off hCaptcha", async () => {
  const result = await solveCaptchaOnPage(mockPage(), { present: true, kind: "hcaptcha", visible: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /hCaptcha/i);
});

test("hasJudgment is true for tiles, text, offset, or skip", () => {
  assert.equal(hasJudgment(undefined), false);
  assert.equal(hasJudgment({}), false);
  assert.equal(hasJudgment({ tiles: [0, 4] }), true);
  assert.equal(hasJudgment({ text: "AB12" }), true);
  assert.equal(hasJudgment({ offsetPx: 120 }), true);
  assert.equal(hasJudgment({ skip: true }), true);
});

test("apply with an unknown challengeId still uses the page kind", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-captcha-apply-"));
  setCaptchaSolverPrefsDir(dir);
  try {
    setCaptchaSolverPrefs({ enabled: true, provider: "agent" });
    clearPendingChallenges();
    const id = rememberPendingForTest("recaptcha");
    clearPendingChallenges();
    const result = await solveCaptchaOnPage(
      mockPage(),
      { present: true, kind: "recaptcha", visible: true },
      { challengeId: id, tiles: [0] },
    );
    assert.equal(result.kind, "recaptcha");
    assert.match(result.message, /iframe is gone|challenge/i);
  } finally {
    clearPendingChallenges();
    setCaptchaSolverPrefsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
