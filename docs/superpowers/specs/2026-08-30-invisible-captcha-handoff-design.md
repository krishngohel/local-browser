# Hand off invisible/score-based bot checks, not just visible CAPTCHAs

**Date:** 2026-08-30
**Status:** Approved, building directly (small, no new tool/detection needed).

## Problem

Real-world test (Inductive Automation application via Echo, 2026-08-30): a 16-field form
filled correctly and fast via `fill_form` (~5.5s), but the final `Submit` click was rejected
twice — identically on a brand-new Echo profile and the real installed one — with "flagged as
possible spam." The page carries Google's invisible reCAPTCHA v3 (score-based, no puzzle to
solve). `captcha_check` already detected this correctly (`present: true, kind: "recaptcha",
visible: false`), but nothing told the assistant that an *invisible* result calls for different
handling than a visible one.

**Root cause is not fixable by spoofing.** Invisible reCAPTCHA scores signals including
`navigator.webdriver` (which Playwright/CDP sets `true`, honestly, because Echo really is
automating). Patching that to lie, or adding any stealth/fingerprint-masking layer, is the same
class of thing this project already declined for CAPTCHA-solving and for Google's OAuth block —
it would make Echo assert it isn't automated when it is, and is reusable as abuse
infrastructure. Not doing that.

**What actually works, honestly:** a score-based check gates the *action* (the click), not the
page load. A real, human-originated mouse click carries none of the automation signals a CDP
`Input.dispatchMouseEvent` does. Echo already has the right primitive for "point at something
without touching it": `hover` moves the assistant cursor to a ref and stops — it never clicks.
So the fix is entirely a guidance/description change: when `captcha_check` reports `present:
true` and `visible: false`, don't click the flagged action — `hover` it (pointing the cursor at
it) and ask the user to click it themselves, then `wait_for` the result. No new detection, no
new tool, no new runtime capability.

## Change

**`captcha_check`'s description** (byte-identical across `src/mcp/tools/read.ts`,
`src/shared/tool-manifest.ts`, and the tool table row in `skills/ECHO-SKILL-TREE.md`):

> "Report whether a CAPTCHA or anti-bot challenge (reCAPTCHA, hCaptcha, Cloudflare Turnstile) is
> on the page. Echo does not solve these. If visible, ask the user to solve it in the Echo
> window. If present but invisible (a score-based check), don't click the flagged action
> yourself — hover its ref so the cursor points at it, then ask the user to click it. Optionally
> target a specific tabId (see tabs_list)."

**`captcha_check`'s runtime `action` field** (`src/mcp/tools/read.ts`), differentiated by
`found.visible` instead of one fixed string:
- visible → unchanged: "Ask the user to solve it in the Echo window, then continue. Echo does
  not solve CAPTCHAs."
- invisible → new: "This is invisible/score-based, not a puzzle to solve. Don't click the
  flagged action yourself — call hover on its ref so the cursor points at it, ask the user to
  click it, then wait_for the result."

**Guidance prose** (not byte-identity-constrained, just needs to stay consistent in meaning)
updated in three places to mention the invisible case alongside the existing visible-CAPTCHA
hand-off:
- `src/main/skill-tree.ts`: the `FALLBACK` markdown's "Always" line, and the compact
  `mcpInstructions()` array.
- `skills/ECHO-SKILL-TREE.md`: the `### HAND OFF` section, the "Fill a form" tiny recipe (call
  `captcha_check` before a submit-style click), and the "Always" list.

**Fallback when `hover` isn't available:** `hover` lives in the `toolsInteract` group, off by
default. The guidance says to call it *if available*; either way, the instruction to hand the
click itself to the user (never click a flagged action via `click`) holds regardless of whether
the cursor-pointing affordance is available.

## Out of scope

- Any change to `navigator.webdriver`, CDP fingerprinting, or "stealth" behavior — declined, see
  Problem section.
- A new tool for this — `hover` already does the job.
- Cursor visual polish (a distinct pulse/highlight for hand-off vs. normal cursor movement) —
  the user declined this for now; can revisit later if the plain cursor dot proves hard to
  notice in practice.

## Testing

- Unit: none needed beyond the existing tool-registration/skill-tree-doc byte-identity tests,
  which must still pass with the new description text applied uniformly in all three required
  locations.
- Manual: re-attempt the Inductive Automation application (or any Ashby-hosted posting) with the
  new guidance in place — the assistant should call `captcha_check` before the submit click,
  see `visible: false`, hover the submit ref, and ask the user to click it rather than clicking
  it itself.
