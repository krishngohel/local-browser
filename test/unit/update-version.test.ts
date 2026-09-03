import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer, pickStrategy } from "../../src/main/update-version";

test("isNewer recognizes a newer patch, minor, and major version", () => {
  assert.equal(isNewer("1.1.0", "v1.1.1"), true);
  assert.equal(isNewer("1.1.0", "v1.2.0"), true);
  assert.equal(isNewer("1.1.0", "v2.0.0"), true);
});

test("isNewer is false for the same version or an older one", () => {
  assert.equal(isNewer("1.1.0", "v1.1.0"), false);
  assert.equal(isNewer("1.1.1", "v1.1.0"), false);
  assert.equal(isNewer("2.0.0", "v1.9.9"), false);
});

test("isNewer treats malformed input as not-newer rather than throwing", () => {
  assert.equal(isNewer("1.1.0", "not-a-version"), false);
  assert.equal(isNewer("garbage", "v1.1.0"), false);
  assert.equal(isNewer("1.1.0", ""), false);
});

test("pickStrategy sends darwin to notify-only and everything else to auto-update", () => {
  assert.equal(pickStrategy("darwin"), "notify-only");
  assert.equal(pickStrategy("win32"), "auto-update");
  assert.equal(pickStrategy("linux"), "auto-update");
});
