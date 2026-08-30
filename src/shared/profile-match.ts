import type { Profile } from "../main/profile";
import type { FormField } from "../main/browser";

/** Label substrings (lowercased) mapped to the profile field they suggest, most specific first. */
const SYNONYMS: { pattern: RegExp; key: keyof Profile }[] = [
  { pattern: /first\s*name|given\s*name/, key: "firstName" },
  { pattern: /last\s*name|surname|family\s*name/, key: "lastName" },
  { pattern: /full\s*name|your\s*name/, key: "fullName" },
  { pattern: /e-?mail/, key: "email" },
  { pattern: /phone|mobile|cell/, key: "phone" },
  { pattern: /address\s*line\s*1|street\s*address|address(?!.*2)/, key: "addressLine1" },
  { pattern: /address\s*line\s*2|apt|suite|unit/, key: "addressLine2" },
  { pattern: /city|town/, key: "city" },
  { pattern: /state|province/, key: "state" },
  { pattern: /zip|postal/, key: "zip" },
  { pattern: /country/, key: "country" },
  { pattern: /linkedin/, key: "linkedin" },
  { pattern: /portfolio|website|personal\s*site/, key: "portfolio" },
  { pattern: /github/, key: "github" },
];

export type ProfileSuggestion = { ref: string; label: string; suggestedValue: string; confidence: "high" };

/**
 * Matches form fields to stored profile values by label text. Never guesses: a field with no
 * ref (nothing to fill), an empty profile value, or no synonym match is simply omitted rather
 * than returned with a low-confidence value — the caller (Claude) decides what to do with
 * gaps, this never fabricates a value.
 */
export function matchProfileToFields(fields: FormField[], profile: Profile): ProfileSuggestion[] {
  const out: ProfileSuggestion[] = [];
  for (const field of fields) {
    if (!field.ref) continue;
    const label = (field.label || field.name || "").toLowerCase();
    if (!label) continue;
    const match = SYNONYMS.find((s) => s.pattern.test(label));
    if (!match) continue;
    const value = profile[match.key];
    if (!value) continue;
    out.push({ ref: field.ref, label: field.label || field.name, suggestedValue: value, confidence: "high" });
  }
  return out;
}
