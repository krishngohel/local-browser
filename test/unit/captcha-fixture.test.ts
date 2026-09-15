import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { captchaSitekeyScript, captchaTokenInjectScript } from "../../src/main/page-scripts";

/**
 * End-to-end accuracy check for the two page-scripts CapSolver depends on, run against the real
 * `scripts/fixtures/captcha.html` in a headless DOM. This is the piece the unit tests for
 * `buildCapSolverTask` cannot cover: that the extractor actually reads the public site key out
 * of a reCAPTCHA-shaped widget, and that the injector writes the token into the response field
 * and fires the page callback the way a solved token would.
 */

const FIXTURE = path.join(process.cwd(), "scripts", "fixtures", "captcha.html");
const FAKE_KEY = "6Le-TEST-fake-sitekey-000000000000000";

type SiteInfo = {
  kind: string;
  sitekey: string;
  version: string | null;
  enterprise: boolean;
  invisible: boolean;
  action: string | null;
};
type InjectResult = { invoked: boolean; fields: number };

function fixtureDom(): JSDOM {
  const html = fs.readFileSync(FIXTURE, "utf8");
  // `dangerously` lets the fixture's inline callback run and lets us `window.eval` the scripts
  // exactly as Echo runs them via Playwright's page.evaluate. No network: the fixture pulls
  // nothing external (the iframe is about:blank), and resources default to non-loading.
  return new JSDOM(html, { runScripts: "dangerously", url: "https://example.com/login" });
}

function runInPage<T>(dom: JSDOM, code: string): T {
  return (dom.window as unknown as { eval: (c: string) => T }).eval(code);
}

test("captchaSitekeyScript reads the public reCAPTCHA v2 key from the fixture DOM", () => {
  const dom = fixtureDom();
  try {
    const info = runInPage<SiteInfo | null>(dom, captchaSitekeyScript("recaptcha"));
    assert.ok(info, "extractor returned null on a reCAPTCHA-shaped widget");
    assert.equal(info.kind, "recaptcha");
    assert.equal(info.sitekey, FAKE_KEY);
    assert.equal(info.version, "v2");
    assert.equal(info.enterprise, false);
    assert.equal(info.invisible, false);
  } finally {
    dom.window.close();
  }
});

test("captchaSitekeyScript still finds the key when biased toward another kind", () => {
  const dom = fixtureDom();
  try {
    // The page only has reCAPTCHA; a Turnstile-biased scan must fall through and still find it.
    const info = runInPage<SiteInfo | null>(dom, captchaSitekeyScript("turnstile"));
    assert.ok(info, "ordered fallback failed to find the reCAPTCHA key");
    assert.equal(info.kind, "recaptcha");
    assert.equal(info.sitekey, FAKE_KEY);
  } finally {
    dom.window.close();
  }
});

test("captchaTokenInjectScript fills the response field and fires the page callback", () => {
  const dom = fixtureDom();
  try {
    const result = runInPage<InjectResult>(dom, captchaTokenInjectScript("recaptcha", "TESTTOKEN-123"));
    const textarea = dom.window.document.getElementById("g-recaptcha-response") as unknown as { value: string };
    assert.equal(textarea.value, "TESTTOKEN-123", "response textarea was not filled with the token");
    assert.equal(result.fields, 1, "exactly one response field should be filled");
    assert.equal(result.invoked, true, "the data-callback should have been invoked");
    // The fixture's onEchoCaptchaToken records whatever token it was handed.
    const seen = (dom.window as unknown as { __echoCaptchaToken?: string }).__echoCaptchaToken;
    assert.equal(seen, "TESTTOKEN-123", "the page callback did not receive the token");
  } finally {
    dom.window.close();
  }
});

test("a token with quotes is embedded safely (no string-concat break)", () => {
  const dom = fixtureDom();
  try {
    const nasty = 'TOK"EN\\with-quotes';
    runInPage<InjectResult>(dom, captchaTokenInjectScript("recaptcha", nasty));
    const textarea = dom.window.document.getElementById("g-recaptcha-response") as unknown as { value: string };
    assert.equal(textarea.value, nasty, "quoted token was not injected verbatim");
  } finally {
    dom.window.close();
  }
});
