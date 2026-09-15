import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { LOGIN_SCAN_SCRIPT } from "../../src/main/page-scripts";

/**
 * Accuracy check for the sign-in-wall detector. The value of the detector is entirely in its
 * precision: it must catch the walls that actually stall a run (a credential prompt, or a real
 * auth URL) while never false-flagging an ordinary application form that merely links to a login
 * page — a false positive would make the assistant hand off on a page it could have completed.
 *
 * Runs the real page script in a headless DOM. The script is written to judge visibility from
 * attributes/inline style (not layout), so jsdom — which has no layout — exercises the same code
 * path Chromium does.
 */

type LoginScan = { present: boolean; kind: string | null; host: string; url: string };

function scan(url: string, bodyHtml: string): LoginScan {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url,
    runScripts: "outside-only",
  });
  try {
    return (dom.window as unknown as { eval: (code: string) => LoginScan }).eval(LOGIN_SCAN_SCRIPT);
  } finally {
    dom.window.close();
  }
}

test("flags a real credential prompt (a visible password field)", () => {
  const r = scan("https://www.linkedin.com/login", `<form><input type="email"><input type="password"></form>`);
  assert.equal(r.present, true);
  assert.equal(r.kind, "password");
});

test("flags a genuine auth URL even before the password step renders", () => {
  // Indeed's email-first step: no password field yet, but the URL is unmistakably an auth endpoint.
  const r = scan("https://secure.indeed.com/auth?redirect=/jobs", `<form><input type="email"><button>Continue</button></form>`);
  assert.equal(r.present, true);
  assert.equal(r.kind, "signin");
});

test("does NOT flag an ATS apply form that only links to sign-in", () => {
  // Greenhouse/Lever-style: text + email + file, a header "Sign in" link, no password, no auth URL.
  const r = scan(
    "https://job-boards.greenhouse.io/acme/jobs/123",
    `<a href="/login">Sign in</a>
     <form>
       <input type="text" name="first_name">
       <input type="email" name="email">
       <input type="file" name="resume">
       <button>Submit application</button>
     </form>`,
  );
  assert.equal(r.present, false);
  assert.equal(r.kind, null);
});

test("does NOT flag a logged-in page whose password field is hidden", () => {
  // A collapsed change-password form on a dashboard must not read as a wall.
  const r = scan(
    "https://app.example.com/dashboard",
    `<div style="display:none"><input type="password"></div><h1>Your applications</h1>`,
  );
  assert.equal(r.present, false);
});

test("ignores a disabled password field", () => {
  const r = scan("https://example.com/home", `<input type="password" disabled>`);
  assert.equal(r.present, false);
});

test("reports the host so the one-time sign-in ping can name the site", () => {
  const r = scan("https://acme.myworkdayjobs.com/en-US/careers/login", `<input type="password">`);
  assert.equal(r.present, true);
  assert.equal(r.host, "acme.myworkdayjobs.com");
});

test("a plain content path with the substring 'login' in a slug is not mistaken for a wall", () => {
  // e.g. a blog post — no password, and the word is not a delimited auth segment.
  const r = scan("https://news.example.com/how-to-login-to-anything", `<h1>Guide</h1>`);
  assert.equal(r.present, false);
});
