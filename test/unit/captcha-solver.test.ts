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
import type { PwFrame, PwLocator, PwPage } from "../../src/main/pw-bridge";

type LocOpts = {
  count?: number;
  visible?: boolean;
  png?: Buffer;
};

function makeLocator(opts: LocOpts = {}): PwLocator {
  const count = opts.count ?? 0;
  const visible = opts.visible ?? count > 0;
  const png = opts.png ?? Buffer.from("png");
  const self = {
    click: async () => {},
    dblclick: async () => {},
    hover: async () => {},
    fill: async () => {},
    press: async () => {},
    selectOption: async () => {},
    dragTo: async () => {},
    boundingBox: async () => (visible ? { x: 0, y: 0, width: 40, height: 40 } : null),
    setInputFiles: async () => {},
    first: () => makeLocator({ count: count > 0 ? 1 : 0, visible, png }),
    nth: () => makeLocator({ count: 1, visible: true, png }),
    count: async () => count,
    screenshot: async () => png,
    innerText: async () => "",
    isVisible: async () => visible,
    getAttribute: async () => null,
  };
  return self;
}

function emptyLocator(): PwLocator {
  return makeLocator({ count: 0, visible: false });
}

function mockPage(frames: PwFrame[] = [], pageLocator: (sel: string) => PwLocator = () => emptyLocator()): PwPage {
  return {
    url: () => "https://example.com/",
    locator: pageLocator,
    frames: () => frames,
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

function recaptchaFrames(opts: { tileCount: number; checked?: boolean }): PwFrame[] {
  const tileCount = opts.tileCount;
  const checked = opts.checked === true;
  const anchor: PwFrame = {
    url: () => "https://www.google.com/recaptcha/api2/anchor?k=1",
    locator: (sel: string) => {
      if (sel.includes("aria-checked='true'")) return makeLocator({ count: checked ? 1 : 0 });
      if (sel.includes("recaptcha-checkbox")) return makeLocator({ count: 1, visible: true });
      return emptyLocator();
    },
  } as PwFrame;
  const challenge: PwFrame = {
    url: () => "https://www.google.com/recaptcha/api2/bframe?k=1",
    locator: (sel: string) => {
      if (sel.includes("rc-imageselect-instructions") || sel.includes("rc-imageselect-desc")) {
        return makeLocator({ count: 1, visible: true, png: Buffer.from("instr") });
      }
      if (sel.includes("rc-imageselect-table")) {
        return makeLocator({ count: tileCount, visible: tileCount > 0, png: Buffer.from("tile") });
      }
      if (sel.includes("recaptcha-verify")) return makeLocator({ count: 1, visible: true });
      return emptyLocator();
    },
  } as PwFrame;
  return [anchor, challenge];
}

function withAgentPrefs(run: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-captcha-agent-"));
  setCaptchaSolverPrefsDir(dir);
  clearPendingChallenges();
  return (async () => {
    try {
      setCaptchaSolverPrefs({ enabled: true, provider: "agent" });
      await run();
    } finally {
      clearPendingChallenges();
      setCaptchaSolverPrefsDir(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
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

test("agent prepare returns needs_judgment with images and no vision API call", async () => {
  await withAgentPrefs(async () => {
    const page = mockPage(recaptchaFrames({ tileCount: 9 }));
    const result = await solveCaptchaOnPage(page, { present: true, kind: "recaptcha", visible: true });
    assert.equal(result.ok, true);
    assert.equal(result.status, "needs_judgment");
    assert.equal(result.method, "agent");
    assert.equal(result.kind, "recaptcha");
    assert.ok(result.challengeId);
    assert.equal(result.tileCount, 9);
    assert.ok(result.prompt && /CAPTCHA|reCAPTCHA/i.test(result.prompt));
    assert.ok(result.images && result.images.length >= 1, "instruction and/or tiles should be attached");
  });
});

test("agent apply uses a pending challengeId then completes", async () => {
  await withAgentPrefs(async () => {
    // Challenge iframe present for clicks, but tile table gone after verify → done.
    let tableVisible = true;
    const frames: PwFrame[] = [
      {
        url: () => "https://www.google.com/recaptcha/api2/anchor?k=1",
        locator: () => emptyLocator(),
      } as PwFrame,
      {
        url: () => "https://www.google.com/recaptcha/api2/bframe?k=1",
        locator: (sel: string) => {
          if (sel.includes("rc-imageselect-table")) {
            return makeLocator({ count: tableVisible ? 9 : 0, visible: tableVisible });
          }
          if (sel.includes("recaptcha-verify")) {
            tableVisible = false;
            return makeLocator({ count: 1, visible: true });
          }
          if (sel.includes("rc-imageselect-table") === false && sel.includes("td")) {
            return makeLocator({ count: 9, visible: true });
          }
          return emptyLocator();
        },
      } as PwFrame,
    ];
    const id = rememberPendingForTest("recaptcha");
    const result = await solveCaptchaOnPage(
      mockPage(frames),
      { present: true, kind: "recaptcha", visible: true },
      { challengeId: id, tiles: [0, 2] },
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, "done");
    assert.equal(result.method, "agent");
  });
});

test("agent apply refuses an unknown challengeId", async () => {
  await withAgentPrefs(async () => {
    const result = await solveCaptchaOnPage(
      mockPage(recaptchaFrames({ tileCount: 9 })),
      { present: true, kind: "recaptcha", visible: true },
      { challengeId: "c-missing", tiles: [0] },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "handoff");
    assert.match(result.message, /expired or is unknown/i);
  });
});
