# Model file uploads

**Date:** 2026-08-27
**Status:** Approved (user delegated design decisions)

## Problem

`upload_file` today only sets pre-existing local paths on a bare `<input type=file>`. Two real
cases fail:

1. The assistant has *authored* the content (a CSV it computed, a text file it drafted) and has
   no way to hand it to the page without a separate filesystem tool writing it first.
2. Many sites hide the input and expose an upload *button* that opens the native OS file
   chooser. Clicking it from the assistant hangs the session on a dialog nobody can drive.

## Design

One tool, `upload_file`, grows two abilities. No new settings switch: it stays inside the
Interaction depth group, and the Settings/README/legal copy tells the truth about the wider
reach.

### 1. Inline files from the model

New optional `files` argument alongside the existing `paths` (now optional too; at least one of
the two is required):

```
files: [{ name, content, encoding?: "text" | "base64" }]   // max 10 per call
```

Echo writes each file into a fresh per-call staging folder under `userData/uploads/` and then
uploads the staged paths exactly like caller-supplied ones. Rules, enforced in a new
Electron-free module `src/main/upload-staging.ts` so they unit-test:

- Names are sanitized: directory parts stripped, Windows-reserved characters and trailing
  dots/spaces removed, empty names fall back to `file`, collisions get ` (2)` style suffixes.
- Decoded size caps: 25 MB per file, 50 MB per call. Invalid base64 is an error, not silence.
- Staging folders older than 24 h are deleted lazily on the next staging call.

### 2. File-chooser interception

`uploadFile` in the hub first asks the page (via `exec`, so frame selection is honoured)
whether the ref is a file input.

- File input → `setInputFiles`, as today.
- Anything else → arm Playwright's `filechooser` interception (`page.waitForEvent`), click the
  ref, and feed the chooser the files. Playwright's interception suppresses the native dialog,
  so the session cannot hang. If no chooser opens within 8 s the tool errors with guidance.
- Unknown ref → the usual "call snapshot for fresh refs" error.

The `PwPage` facade in `pw-bridge.ts` gains `waitForEvent("filechooser")` and a `PwFileChooser`
type (`setFiles`).

## Components

- `src/main/upload-staging.ts` (new) — pure staging logic + stale cleanup, unit tested.
- `src/main/paths.ts` — `uploadsDir()`.
- `src/main/pw-bridge.ts` — filechooser facade types.
- `src/main/page-scripts.ts` — `fileInputKindScript(ref)` (null / "file-input" / "other").
- `src/main/browser.ts` — `uploadFile` branches on element kind.
- `src/mcp/tools/interact.ts` — widened schema, staging call, updated description.
- Copy: `tool-manifest.ts`, Settings card + AI-control terms in `index.html`, README,
  `skills/ECHO-SKILL-TREE.md`.

## Error handling

- Neither `paths` nor `files` given → error asking for one.
- Missing local path, oversized/invalid inline file → error naming the offender.
- Ref not an input and click opens no chooser → error telling the assistant to target the real
  upload control.
- Playwright not attached → existing retry-in-a-moment error.

## Testing

- `test/unit/upload-staging.test.ts` — sanitization, base64, caps, collision suffixes, stale
  cleanup.
- `scripts/test-tools.mjs` — inline upload onto the fixture file input; chooser-button upload
  via a new "Pick files" button in `scripts/fixtures/forms.html` that opens a detached input's
  chooser and records the picked name.
