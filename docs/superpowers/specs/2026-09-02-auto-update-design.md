# Auto-update installed copies of Echo

**Date:** 2026-09-02
**Status:** Approved, building.

## Purpose

Today, updating Echo means someone has to notice a new GitHub release exists and manually
re-download and reinstall it. Every installed copy silently drifts behind. This adds
auto-update so that cutting a release (the existing bump-version → tag → push workflow) is
also "ship an update to everyone already running Echo" — without ever touching or requiring a
paid code-signing certificate, and without ever interrupting a live browser session mid-task
(job applications routinely run for minutes across several tabs).

## Decisions from brainstorming

- **Trigger is a tagged release, not every commit.** Installed Echo checks GitHub for a newer
  *version* (a `vX.Y.Z` tag that the existing `.github/workflows/release.yml` already turns
  into a GitHub Release with built installers). A plain push to `main` with no new tag changes
  nothing for installed copies. This matches how virtually every desktop app's auto-update
  works and requires no change to the existing release habit.
- **Mac gets notify-only, not silent auto-update.** Squirrel.Mac (the mechanism
  `electron-updater` uses to apply Mac updates) verifies the running app and the downloaded
  update have matching code signatures before it will swap them — unsigned apps generally
  can't auto-update themselves cleanly. Since `mac.identity` is deliberately `null` and
  `notarize: false` in `package.json` (no cert, by prior decision), Mac does a lightweight
  version check only: when a newer release exists, show a toast whose action opens that
  release's GitHub page for a manual DMG reinstall. Windows and Linux need no signing to
  auto-update and get the full silent flow.
- **Never force a restart.** Windows/Linux downloads happen silently in the background. Once
  a downloaded update is ready to apply, Echo shows "Update ready — Restart now" and applies
  it only when the user clicks that, or the next time they naturally quit and reopen Echo —
  never on a timer, never based on a guessed "idle" heuristic. Echo can be mid-way through
  driving several tabs through a job application; nothing should yank that out from under
  the user without being asked.
- **Silent failure on check errors.** No internet, GitHub rate-limited, malformed release —
  the check just logs and retries on the next interval. This is a background convenience
  feature; it must never surface a scary error to someone in the middle of using Echo for
  something else.

## Architecture

Two independent paths, because Mac's constraint (no signing) makes it a fundamentally
different mechanism from Windows/Linux, not just a variant of the same one:

**Windows & Linux — `electron-updater`'s real `autoUpdater`.**
Reads the `latest.yml` (Windows) / `latest-linux.yml` (Linux) metadata files that
`electron-builder` writes alongside the installers when a `publish` block exists in
`package.json`. `electron-updater` handles the version comparison, the background download,
and (once the user clicks "Restart now") re-launching into the new version via
`quitAndInstall()`. Windows' NSIS updater runs the new installer silently (`/S`) itself — no
extra UAC prompt, since `nsis.perMachine` is already `false` (per-user install, already the
case today). Linux's `AppImageUpdater` downloads the new AppImage and replaces the running
one in place, which needs the running AppImage's own file to be writable — true for the
common case of a user-downloaded file in their own home directory.

**Mac — a small custom checker, not `electron-updater` at all.**
A periodic `fetch()` of GitHub's public REST endpoint
`GET https://api.github.com/repos/krishngohel/local-browser/releases/latest`, comparing its
`tag_name` (semver) against `app.getVersion()`. When newer, the toast's action opens that
response's `html_url` (the release page) in the default browser. No `latest-mac.yml`, no
Squirrel.Mac, no download — sidesteps the signing requirement entirely instead of fighting it.
GitHub's unauthenticated rate limit (60 req/hour) is per calling IP, so this is fine at any
realistic number of installs checking a few times a day each.

**Check cadence (all platforms):** once on app ready (a short delay after launch so it never
competes with startup), then every 4 hours while Echo keeps running — reasonable for a
long-lived tray app, avoids hammering GitHub.

## Components

- **`src/main/updater.ts`** (new) — owns both paths.
  - `startUpdateChecks()`, called once from `src/main/index.ts` on app ready: branches on
    `process.platform`. Windows/Linux wire `electron-updater`'s `autoUpdater` events
    (`update-available`, `download-progress` (logged only, not surfaced in UI), `update-downloaded`,
    `error`) into the shared status below. Mac runs its own `setInterval` calling the GitHub
    REST check.
  - A shared `UpdateStatus` value — `{ state: "idle" | "checking" | "downloading" |
    "ready" | "mac-available" | "error", version?: string, releaseUrl?: string }` — kept in
    this module and broadcast to renderer windows the same way other app state already is
    (`src/shared/types.ts`'s `AppState`, pushed on every state-changing event per
    `settings.ts`'s existing pattern). `"ready"` is the Windows/Linux "click to restart" state;
    `"mac-available"` is the Mac "click to open the release page" state.
  - `applyUpdateNow()` — called from the renderer's "Restart now" action. Windows/Linux: calls
    `autoUpdater.quitAndInstall()`. Mac path never reaches this function (its action opens a
    URL directly, no IPC needed beyond that).
- **`src/shared/types.ts`** — `AppState` gains `updateStatus: UpdateStatus`.
  `package.json`'s own `version` field is already `app.getVersion()`'s source; no new field
  needed to know the *current* version.
- **`src/renderer/ui/toasts.ts`** — `toast()` gains an optional fourth argument for a single
  action button (`{ label, onClick }`). When present, the toast does not auto-dismiss on the
  existing 3.5s timer — it stays until clicked or manually dismissed. This is the only change
  to this module; every existing `toast(message, kind)` call site is unaffected (the new
  argument is optional).
- **`src/renderer/ui/settings.ts`** — a small "Software update" line (not a full new section)
  near the top of the existing Settings page: shows the running version, and when
  `updateStatus.state` is `"ready"` or `"mac-available"`, the same restart / open-release-page
  action as the toast. This exists so the information isn't lost once the toast's dismiss
  window passes — someone who was away from the computer when the toast appeared can still
  find it.
- **`package.json`** — add:
  ```json
  "publish": { "provider": "github", "owner": "krishngohel", "repo": "local-browser" }
  ```
  under `build`. This makes `electron-builder` write the metadata files locally during
  `dist:win` / `dist:linux` — the existing `dist:*` npm scripts keep `--publish never`, since
  GitHub Actions already handles the actual upload via `softprops/action-gh-release`; this
  flag only controls whether electron-builder itself pushes to GitHub, not whether it writes
  the metadata files. `electron-updater` is added as a runtime `dependency` (it is required at
  app runtime, unlike `electron-builder` which stays a dev dependency).
- **`.github/workflows/release.yml`** — the `artifact` glob for the Windows and Linux matrix
  entries needs to also catch the new metadata/blockmap files so they reach the release
  alongside the installers:
  - Windows: `dist-installer/Echo-Setup-*.exe` → also `dist-installer/latest.yml` and
    `dist-installer/Echo-Setup-*.exe.blockmap`
  - Linux: `dist-installer/Echo-*.AppImage` → also `dist-installer/latest-linux.yml` and
    `dist-installer/Echo-*.AppImage.blockmap`
  - Mac's artifact glob is unchanged — no metadata file is produced or needed for the
    notify-only path.

## UX flow (end to end)

1. You bump `version` in `package.json`, `git tag vX.Y.Z`, `git push --tags` — exactly today's
   process, nothing new here.
2. `release.yml` builds and publishes the release with installers + the new metadata files.
3. An already-running, already-installed Echo on someone's machine hits its next check
   (on launch, or within 4 hours): Windows/Linux silently download the update in the
   background; Mac just notices a newer version exists.
4. A toast appears: Windows/Linux — "Echo vX.Y.Z is ready — Restart now"; Mac — "Echo vX.Y.Z
   is available — View release". The same status persists as a line in Settings.
5. Windows/Linux: nothing happens until the user clicks "Restart now" (or naturally quits and
   reopens Echo, which also applies the already-downloaded update on the next launch). Mac:
   clicking "View release" opens the GitHub release page in the default browser for a manual
   DMG reinstall — Echo itself never downloads or touches anything on Mac.

## Error handling

- Update check fails (offline, GitHub down, rate-limited, malformed feed): log only, no
  toast, no Settings change, retried on the next 4-hour interval.
- Windows/Linux download fails partway: `electron-updater`'s own `error` event — treated the
  same as a check failure (logged, silent, retried next interval). Never partially apply.
- `quitAndInstall()` itself failing (e.g., disk full) is `electron-updater`/NSIS's own
  failure surface — Echo does not add custom handling beyond logging the `error` event, since
  there is no safe automatic recovery to attempt from the renderer side.

## Security note

Without a code-signing certificate, nothing beyond HTTPS-to-GitHub protects the integrity of
a downloaded Windows/Linux update — the same trust boundary the manual-download install
already has today (this project's installers have always been unsigned, by prior explicit
decision). This is not a new risk introduced by auto-update; it is the same risk, delivered
automatically instead of manually. Mac's notify-only design means Mac's trust boundary is
completely unchanged — a human still runs the same manual, Gatekeeper-checked DMG install
they do today.

## Testing

- **Unit-testable, in `scripts/run-unit-tests.js`'s suite:** the semver comparison used by the
  Mac checker (`isNewer(current, latestTag)`), and the branch that decides
  Windows/Linux-real-autoUpdater vs. Mac-notify-only based on `process.platform` (mockable —
  `process.platform` can be stubbed in a unit test without touching the real OS).
- **Not realistically unit-testable, and not attempted:** the actual `electron-updater`
  download/apply cycle against a real GitHub release — that library's own test suite already
  covers its NSIS/AppImage mechanics; re-testing it here would just be testing
  `electron-updater` itself, not this project's code.
- **Manual end-to-end verification (once, after implementation):** publish a real `v1.1.1`
  test release, confirm an already-installed `v1.1.0` Windows copy silently downloads it and
  the "Restart now" toast/Settings line appears, click it, confirm it relaunches as `v1.1.1`.
  Repeat the check-only path on Mac (confirm the toast appears and its link opens the correct
  release page) without expecting a download.

## Out of scope

- No update channel selection (beta/stable) — every tagged release is the update target.
- No changelog/release-notes display inside the toast or Settings — the "Restart now"/
  "View release" action's destination (the GitHub release page) is where release notes live.
- No rollback mechanism — if a bad version ships, the fix is cutting a new tagged release,
  same as any other bug fix today.
- No attempt to make Mac auto-update silently despite being unsigned — revisit only if Apple
  Developer Program enrollment ($99/yr) is decided on separately in the future.
