import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCapSolverTask,
  readSolutionToken,
  type CapSolverSiteInfo,
} from "../../src/main/captcha-capsolver";
import { captchaSitekeyScript, captchaTokenInjectScript } from "../../src/main/page-scripts";

const base: CapSolverSiteInfo = {
  kind: "recaptcha",
  sitekey: "KEY",
  version: "v2",
  enterprise: false,
  invisible: false,
  action: null,
};

test("buildCapSolverTask maps a proxyless reCAPTCHA v2 with the page URL + site key", () => {
  const t = buildCapSolverTask(base, "https://ex.com/login");
  assert.equal(t.type, "ReCaptchaV2TaskProxyLess");
  assert.equal(t.websiteURL, "https://ex.com/login");
  assert.equal(t.websiteKey, "KEY");
  assert.equal(t.isInvisible, undefined);
});

test("buildCapSolverTask flags invisible v2 and enterprise variants", () => {
  assert.equal(buildCapSolverTask({ ...base, invisible: true }, "u").isInvisible, true);
  assert.equal(
    buildCapSolverTask({ ...base, enterprise: true }, "u").type,
    "ReCaptchaV2EnterpriseTaskProxyLess",
  );
});

test("buildCapSolverTask maps v3 with a default (and explicit) page action", () => {
  const t = buildCapSolverTask({ ...base, version: "v3" }, "u");
  assert.equal(t.type, "ReCaptchaV3TaskProxyLess");
  assert.equal(t.pageAction, "verify");
  const t2 = buildCapSolverTask({ ...base, version: "v3", action: "login", enterprise: true }, "u");
  assert.equal(t2.type, "ReCaptchaV3EnterpriseTaskProxyLess");
  assert.equal(t2.pageAction, "login");
});

test("buildCapSolverTask maps hCaptcha and Turnstile", () => {
  const h = buildCapSolverTask({ ...base, kind: "hcaptcha", version: null, invisible: true }, "u");
  assert.equal(h.type, "HCaptchaTaskProxyLess");
  assert.equal(h.isInvisible, true);
  const ts = buildCapSolverTask({ ...base, kind: "turnstile", version: null, action: "managed" }, "u");
  assert.equal(ts.type, "AntiTurnstileTaskProxyLess");
  assert.deepEqual(ts.metadata, { action: "managed" });
});

test("buildCapSolverTask refuses to build without a site key", () => {
  assert.throws(() => buildCapSolverTask({ ...base, sitekey: null }, "u"), /site key/);
});

test("readSolutionToken reads the right field per family", () => {
  assert.equal(readSolutionToken({ gRecaptchaResponse: "g" }, "recaptcha"), "g");
  assert.equal(readSolutionToken({ gRecaptchaResponse: "g" }, "hcaptcha"), "g");
  assert.equal(readSolutionToken({ token: "cf" }, "turnstile"), "cf");
  assert.equal(readSolutionToken(undefined, "recaptcha"), "");
});

test("captchaSitekeyScript prefers the detected kind and reads only public keys", () => {
  const s = captchaSitekeyScript("turnstile");
  assert.match(s, /cf-turnstile\[data-sitekey\]/);
  assert.match(s, /data-hcaptcha-sitekey/);
  assert.match(s, /param\(s\.src, 'render'\)/); // v3 render param parsing
  assert.match(s, /const prefer = "turnstile"/);
});

test("captchaTokenInjectScript sets the response field, fires the callback, and JSON-embeds the token", () => {
  const r = captchaTokenInjectScript("recaptcha", 'TOK"EN');
  assert.match(r, /g-recaptcha-response/);
  assert.match(r, /___grecaptcha_cfg/);
  // The token is embedded via JSON.stringify, so a quote in it is escaped, never string-concatenated.
  assert.match(r, /"TOK\\"EN"/);
  const ts = captchaTokenInjectScript("turnstile", "T");
  assert.match(ts, /cf-turnstile-response/);
});
