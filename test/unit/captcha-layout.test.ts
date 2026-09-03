import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CAPTCHA_MIN_VIEW,
  growContentForCaptcha,
  isCaptchaFrameUrl,
  pageViewBounds,
} from "../../src/main/captcha-layout";
import { CAPTCHA_REVEAL_SCRIPT, CAPTCHA_SCAN_SCRIPT } from "../../src/main/page-scripts";

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`Could not find the repo root from ${__dirname}`);
}

test("pageViewBounds slides the view down and shrinks its height by the overlay", () => {
  const box = pageViewBounds(1280, 800, 84, 120);
  assert.deepEqual(box, { x: 0, y: 204, width: 1280, height: 596 });
});

test("pageViewBounds does not go negative when chrome eats the window", () => {
  const box = pageViewBounds(900, 100, 84, 40);
  assert.equal(box.height, 0);
  assert.equal(box.y, 124);
});

test("growContentForCaptcha enlarges a short window enough for a challenge iframe", () => {
  // 600px content − 84 chrome = 516px page, which clips a ~580px reCAPTCHA bframe.
  const next = growContentForCaptcha({
    contentWidth: 900,
    contentHeight: 600,
    chromeHeight: 84,
    overlayHeight: 0,
    widgetWidth: 78,
    widgetHeight: 78,
    maxContentWidth: 1920,
    maxContentHeight: 1080,
    ensureMinView: true,
  });
  assert.equal(next.grew, true);
  assert.ok(next.height >= 84 + CAPTCHA_MIN_VIEW.height, "content height must fit the min challenge view");
  assert.ok(next.width >= CAPTCHA_MIN_VIEW.width);
});

test("growContentForCaptcha does not grow for a recaptcha badge without ensureMinView", () => {
  const next = growContentForCaptcha({
    contentWidth: 900,
    contentHeight: 600,
    chromeHeight: 84,
    overlayHeight: 0,
    widgetWidth: 70,
    widgetHeight: 70,
    maxContentWidth: 1920,
    maxContentHeight: 1080,
  });
  assert.equal(next.grew, false);
});

test("growContentForCaptcha never shrinks and respects a maximized window", () => {
  const same = growContentForCaptcha({
    contentWidth: 1600,
    contentHeight: 1000,
    chromeHeight: 84,
    overlayHeight: 0,
    widgetWidth: 400,
    widgetHeight: 580,
    maxContentWidth: 1920,
    maxContentHeight: 1080,
  });
  assert.equal(same.grew, false);
  assert.equal(same.width, 1600);
  assert.equal(same.height, 1000);

  const locked = growContentForCaptcha({
    contentWidth: 800,
    contentHeight: 500,
    chromeHeight: 84,
    overlayHeight: 0,
    widgetWidth: 400,
    widgetHeight: 580,
    maxContentWidth: 1920,
    maxContentHeight: 1080,
    locked: true,
  });
  assert.equal(locked.grew, false);
  assert.equal(locked.height, 500);
});

test("growContentForCaptcha does not exceed the work area", () => {
  const next = growContentForCaptcha({
    contentWidth: 800,
    contentHeight: 500,
    chromeHeight: 84,
    overlayHeight: 0,
    widgetWidth: 400,
    widgetHeight: 900,
    maxContentWidth: 1000,
    maxContentHeight: 700,
  });
  assert.equal(next.width, 800);
  assert.equal(next.height, 700);
});

test("isCaptchaFrameUrl matches challenge hosts", () => {
  assert.equal(isCaptchaFrameUrl("https://www.google.com/recaptcha/api2/bframe?k=1"), true);
  assert.equal(isCaptchaFrameUrl("https://example.com/login"), false);
});

test("CAPTCHA_SCAN_SCRIPT treats off-screen painted widgets as visible", () => {
  assert.match(CAPTCHA_SCAN_SCRIPT, /Do not require the box to intersect the viewport/);
  assert.equal(CAPTCHA_SCAN_SCRIPT.includes("r.top > vh"), false);
});

test("CAPTCHA_REVEAL_SCRIPT unclips overflow and does not freeze iframe size", () => {
  assert.match(CAPTCHA_REVEAL_SCRIPT, /overflow = 'visible'/);
  assert.match(CAPTCHA_REVEAL_SCRIPT, /bframe/);
  assert.equal(CAPTCHA_REVEAL_SCRIPT.includes("style.width ="), false);
  assert.equal(CAPTCHA_REVEAL_SCRIPT.includes("style.height ="), false);
});

test("layout() sizes the BrowserView through pageViewBounds so overlays cannot clip the page", () => {
  const src = fs.readFileSync(path.join(repoRoot(), "src", "main", "browser.ts"), "utf8");
  assert.match(src, /view\.setBounds\(pageViewBounds\(/);
  assert.match(src, /getContentSize\(\)/);
});
