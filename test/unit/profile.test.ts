import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROFILE, getProfile, setProfile } from "../../src/main/profile";

test("profile default and persist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-profile-"));
  assert.deepEqual(getProfile(dir), DEFAULT_PROFILE);
  const next = setProfile({ fullName: "Ada Lovelace", email: "ada@example.com" }, dir);
  assert.equal(next.fullName, "Ada Lovelace");
  assert.equal(getProfile(dir).email, "ada@example.com");
});

test("setProfile merges partial updates and rejects bad fields without clobbering good ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-profile-"));
  setProfile({ fullName: "Ada Lovelace", email: "ada@example.com" }, dir);
  const withBadEmail = setProfile({ email: 123 as never }, dir); // wrong type, should be ignored
  assert.equal(withBadEmail.fullName, "Ada Lovelace");
  assert.equal(withBadEmail.email, "ada@example.com");
  const read = getProfile(dir);
  assert.equal(read.fullName, "Ada Lovelace");
});
