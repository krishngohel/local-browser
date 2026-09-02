# Multi-tab concurrent applications (tabId tools, live grid, cursor, batch fill, profile)

**Date:** 2026-08-29
**Status:** Design approved, not yet built.

## Problem

Echo is used to fill out job applications quickly. Today that's slower than it should be for
two reasons that compound when working several applications at once:

1. **No real multitasking.** Every interact/read tool (`click`, `type`, `fill`, `select`,
   `hover`, `press`, `scroll`, `get_text`, `find`, `forms`, `links`, `tables`, `page_info`,
   `html`, `wait_for`, `captcha_check`, `frames`/`frame_select`) implicitly targets whatever tab
   is currently "active" (`BrowserHub.requireActive()` in `src/main/browser.ts`). Only `navigate`
   accepts an optional `tabId`. Snapshot/form refs are already scoped per-tab
   (`tab.snapshotByRef`), but dispatch ignores that and always resolves against the active tab.
   The result: Claude can't work two application tabs "at the same time" — it has to
   `tabs_select` back and forth, one action at a time, and a stray active-tab change could make
   an action land on the wrong tab.
2. **Too many round-trips per form.** Filling a field is a `find`-then-`type` (or `fill`) pair;
   a 10-field application costs ~10 round-trips with no batching.

On top of the core ask, the user wants to *watch* several applications progress simultaneously
(a live grid, not just background automation), and wants a visible on-screen indicator of what
Claude is doing.

Out of scope for this spec (deferred, separate design later): the Google "unverified browser"
OAuth sign-in block. That's largely a deliberate Google policy against embedded/automated
browsers, not a fingerprint fix, and deserves its own investigation.

## 1. tabId on every tool + per-tab queues

Add an optional `tabId` parameter to every read/interact tool listed above (mirroring
`navigate`'s existing shape). Internally, `BrowserHub` dispatch resolves the target tab from
`tabId` when given, falling back to the active tab when omitted (existing single-tab behavior is
unchanged). Ref-scoped tools (`click`, `type`, `fill`, `select`, `hover`) validate the ref
against *that* tab's `snapshotByRef`/`formsByRef` map, not the active tab's.

`BrowserHub` gives each tab its own action queue: a promise chain that serializes calls
targeting the same `tabId` (so two rapid actions on one tab never interleave) while calls
targeting different tabs run fully concurrently. This is the mechanism that actually lets Claude
issue parallel tool calls across tabs and have them overlap instead of serializing through one
global active-tab lock.

Tools unaffected: `tabs_list`, `tabs_new`, `tabs_close`, `tabs_select` stay as-is; `navigate`
keeps its existing `tabId` param unchanged.

## 2. Live multi-tab grid: "Applications" workspace

To let the user watch several applications at once, a subset of tabs render simultaneously
instead of Echo's normal one-`BrowserView`-attached-at-a-time model. Mechanism: Electron
offscreen rendering (OSR) — a tab's `webContents` created with `offscreen: true` paints into a
buffer via `paint` events regardless of window attachment, so its frames are available any time,
not just while it's the visible tab. The renderer draws each tab's latest frame into its own
`<canvas>` tile arranged in a grid.

OSR is software-composited and costs more CPU/memory per tab than native `BrowserView`
compositing — acceptable for a handful of mostly-static application forms, wasteful if applied
to every tab ever opened (general browsing). So this is scoped to an explicit **Applications
workspace**, not a global rendering-mode switch:

- `apps_session_start({ urls: string[] })` opens one OSR tab per URL, returns their tab ids, and
  switches the window into grid view showing those tiles (up to a cap — default 6 concurrent
  tabs; configurable, since OSR tiles are real overhead).
- `apps_session_end()` closes the grid view; tabs can be kept open (reverting to normal
  attached-tab browsing) or closed, caller's choice.
- Regular tabs opened via `tabs_new` are unaffected — still native `BrowserView`, unchanged
  performance.
- Clicking a tile promotes it into the main single-tab view for manual interaction (typing your
  own answers, solving a CAPTCHA in it directly); Claude keeps driving every tab in the session
  through the `tabId`-addressed tools from Section 1 regardless of which tile is promoted.
- Existing screenshot/watch tools work against OSR tabs the same way they do today, since OSR
  frames are always capturable (no more "detached BrowserView capturePage() never resolves"
  restriction *for tabs in this mode* — that limitation stays true for ordinary tabs, which is
  fine since ordinary tabs aren't part of a concurrent-viewing workflow).

## 3. Assistant cursor overlay

A small floating cursor element is injected into the page itself — a fixed-position,
`pointer-events: none` div, re-injected on every navigation the same way Echo already injects
its selector script for `snapshot()` (`ECHO_SELECTORS_SOURCE` pattern). Before `click`, `type`,
`hover`, or `select`, the hub computes the target element's on-screen position via
`getBoundingClientRect()` and animates the cursor there, then performs the action — riding on
the existing human-pacing delay (`src/main/pacing.ts`) as visual "travel time".

Because the cursor is baked into the page's own rendered pixels, it shows up automatically
whether the user is watching that tab normally or as an OSR grid tile — no separate
canvas-drawing or coordinate-translation code needed for the grid case. A new setting
(`showAssistantCursor`, default on) toggles it off if ever distracting; lives in
Settings → System next to `humanPacing`.

## 4. Batch fill

New tool `fill_form`:

```
fill_form({ tabId?: string, fields: [{ ref: string, value: string }] })
```

Applies every field in one round-trip. Type-aware per ref, using the tag/`inputType` cached from
that tab's last `snapshot()`/`forms()` call: text/textarea inputs go through the existing `fill`
path, `<select>` through `select`, checkbox/radio through `click`. Returns a per-field result
list (`{ ref, ok, error? }`) rather than failing the whole call on one bad ref, so a form with 9
good fields and 1 stale ref still fills the 9.

## 5. Profile store

`src/main/profile.ts`, same JSON-in-userData pattern as `settings.ts` (`getProfile`/`setProfile`,
sanitize-with-fallback on bad fields). Stable identity fields only — no resume storage, since
resumes are tailored per application and already handled by the existing `upload_file` tool:

- `fullName`, `firstName`, `lastName`
- `email`, `phone`
- `addressLine1`, `addressLine2`, `city`, `state`, `zip`, `country`
- `linkedin`, `portfolio`, `github` (optional links)

Editable two ways:
- **Settings → Profile**, a new section in the renderer settings UI (`src/renderer/ui/settings.ts`)
  with plain text inputs, following the existing section pattern.
- **`profile_set` / `profile_get` tools**, so Claude can save/update fields when the user states
  them in chat, and read them back before filling a form.

New tool `profile_suggest_fill({ tabId })`: takes that tab's last `forms()` output, matches field
labels against profile keys via a synonym dictionary ("first name" / "given name" → `firstName`;
"email address" → `email`; "phone number" / "mobile" → `phone`; etc.), and returns
`{ ref, label, suggestedValue, confidence }` per match. **It never fills anything itself** —
Claude reviews the suggestions, skips low-confidence or ambiguous ones (asking the user if
unsure), and calls `fill_form` with what it accepts. This keeps a review step so a wrong guess
never silently lands in a submitted application.

## 6. Bookkeeping

- New tools (`fill_form`, `profile_set`, `profile_get`, `profile_suggest_fill`,
  `apps_session_start`, `apps_session_end`) are added to `TOOL_MANIFEST`
  (`src/shared/tool-manifest.ts`), group counts, skill tree, and README together, per existing
  convention. `fill_form` → `toolsInteract`; the profile and session tools → `toolsState`.
- `tabId` becoming optional on existing tools is a description-only change (one added sentence
  per tool), not a new tool — total tool count only grows by the six new tools above.
- Default cap of 6 concurrent Applications-session tabs (adjustable) bounds OSR memory/CPU cost.
- `npx tsc --noEmit`, `npm run test:unit`, `npm run test:tools`, `npm run test:bridge`,
  `npm run packaging:check` all need to stay green; judge only newly introduced errors against
  the 4 pre-existing ones noted in project memory.

## Testing approach

- Unit tests for the per-tab queue (two queued actions on the same tabId run in submission
  order; actions on different tabIds interleave/run concurrently — assert via timing or a shared
  counter with artificial delays).
- Unit tests for `profile_suggest_fill`'s label-matching dictionary (exact and synonym matches,
  no match returns nothing rather than a low-confidence guess).
- E2e (`test:tools` fixture-server style): open two fixture-server tabs, drive both via
  `tabId`-addressed tools in overlapping calls, assert both completed correctly and neither
  clobbered the other's ref/queue.
- E2e for `fill_form`: a fixture form with text/select/checkbox fields, one `fill_form` call,
  assert all fields land and one bad ref doesn't block the rest.
- Manual verification: cursor overlay visible in the installed Echo window; grid view with 2-3
  tabs actually shows independent live frames; `apps_session_start`/`apps_session_end` cleans up
  OSR tabs correctly (no leaked offscreen renderer processes).
