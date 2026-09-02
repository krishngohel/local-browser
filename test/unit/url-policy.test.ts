import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSISTANT_NAV_REFUSAL, isAssistantNavigable } from "../../src/shared/url-policy";

test("web URLs are navigable by an assistant", () => {
  for (const url of [
    "https://example.com",
    "http://127.0.0.1:8080/fixtures/index.html",
    "HTTPS://EXAMPLE.COM/Path?q=1#frag",
    "https://example.com/a?next=file:///C:/secret.txt",
  ]) {
    assert.equal(isAssistantNavigable(url), true, url);
  }
});

test("bare words and bare hosts are navigable — normalizeUrl makes them https or a search", () => {
  for (const input of ["example.com", "how tall is everest", "", "   ", "localhost/index.html"]) {
    assert.equal(isAssistantNavigable(input), true, JSON.stringify(input));
  }
});

test("about:blank and data: are allowed, other about: pages are not", () => {
  assert.equal(isAssistantNavigable("about:blank"), true);
  assert.equal(isAssistantNavigable("ABOUT:BLANK"), true);
  assert.equal(isAssistantNavigable("about:blank#x"), true);
  assert.equal(isAssistantNavigable("data:text/html,<p>hi</p>"), true);
  assert.equal(isAssistantNavigable("about:config"), false);
  assert.equal(isAssistantNavigable("about:blankextra"), false);
});

test("local and privileged schemes are refused", () => {
  for (const url of [
    "file:///C:/Users/me/.ssh/id_rsa",
    "FILE:///etc/passwd",
    "  file:///etc/passwd  ",
    "javascript:alert(1)",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.com",
    "blob:https://example.com/abc",
    "ftp://example.com/x",
    "ws://example.com/x",
    "filesystem:https://example.com/temporary/x",
    "c:\\Users\\me\\notes.txt",
  ]) {
    assert.equal(isAssistantNavigable(url), false, url);
  }
});

test("the refusal names the address bar as the way to open a local file", () => {
  assert.match(ASSISTANT_NAV_REFUSAL, /http\(s\)/);
  assert.match(ASSISTANT_NAV_REFUSAL, /address bar/);
});
