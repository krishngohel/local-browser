import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROFILE } from "../../src/main/profile";
import { matchProfileToFields } from "../../src/shared/profile-match";
import type { FormField } from "../../src/main/browser";

test("matches common label synonyms to profile fields and skips fields with no match or no ref", () => {
  const profile = { ...DEFAULT_PROFILE, firstName: "Ada", email: "ada@example.com", phone: "555-0100" };
  const fields: FormField[] = [
    { name: "fname", type: "text", value: "", label: "First Name", ref: "e0" },
    { name: "email_addr", type: "email", value: "", label: "Email Address", ref: "e1" },
    { name: "referral", type: "text", value: "", label: "How did you hear about us?", ref: "e2" },
    { name: "phone", type: "tel", value: "", label: "Mobile Number", ref: undefined },
  ];
  const matches = matchProfileToFields(fields, profile);
  assert.deepEqual(
    matches.map((m) => m.ref),
    ["e0", "e1"],
  );
  assert.equal(matches[0].suggestedValue, "Ada");
  assert.equal(matches[1].suggestedValue, "ada@example.com");
});

test("never fabricates a value for an empty profile field even when the label matches", () => {
  const fields: FormField[] = [{ name: "linkedin", type: "text", value: "", label: "LinkedIn URL", ref: "e0" }];
  const matches = matchProfileToFields(fields, DEFAULT_PROFILE);
  assert.deepEqual(matches, []);
});

test("skips fields with an empty label and unmatched synonyms", () => {
  const profile = { ...DEFAULT_PROFILE, city: "Austin" };
  const fields: FormField[] = [
    { name: "mystery", type: "text", value: "", label: "", ref: "e0" },
    { name: "favoriteColor", type: "text", value: "", label: "Favorite Color", ref: "e1" },
    { name: "city", type: "text", value: "", label: "City", ref: "e2" },
  ];
  const matches = matchProfileToFields(fields, profile);
  assert.deepEqual(
    matches.map((m) => m.ref),
    ["e2"],
  );
  assert.equal(matches[0].suggestedValue, "Austin");
});
