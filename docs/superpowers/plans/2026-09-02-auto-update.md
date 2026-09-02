# Auto-update installed Echo copies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installed Echo copies notice a new GitHub release and update themselves — silently and automatically on Windows/Linux, with a notify-only "a new version exists" nudge on Mac (no code-signing cert, so Mac can't reliably self-apply an update).

**Architecture:** Two independent check paths live in a new `src/main/updater.ts`, driven by a tiny electron-free helper module (`src/main/update-version.ts`) for the parts that need to be unit-testable. Windows/Linux use the real `electron-updater` library (silent background download, `quitAndInstall()` only on explicit request). Mac polls GitHub's public REST API directly and only ever opens a URL. Status flows to the renderer through the existing `AppState` broadcast mechanism (`getState()` / `broadcast()` in `src/main/index.ts`) exactly like every other piece of app state already does.

**Tech Stack:** Electron 36, TypeScript, esbuild (bundled main/preload/renderer), `electron-builder` ^26, new runtime dependency `electron-updater` ^6.

## Global Constraints

- No code-signing certificates anywhere in this project — `build.mac.identity` stays `null`, `build.win.signExecutable` stays `false`. `scripts/check-packaging.js` already enforces the Mac side of this; do not weaken it.
- Update checks (Windows/Linux `electron-updater` calls and the Mac GitHub API poll) are a **no-op whenever `app.isPackaged` is `false`** — dev mode (`npm start`) and the e2e test harness (`ECHO_TEST=1`) must never make a network call or touch `electron-updater`'s feed machinery, since neither has a real `app-update.yml`.
- **Never force a restart.** Windows/Linux: download silently, apply only when the user clicks "Restart now," or the app's own next natural quit (this is `electron-updater`'s own default behavior — do not disable it, and do not add a timer-based auto-restart). Mac: never downloads anything at all — only opens a URL the user clicks.
- **Update-check failures are always silent** — `console.error` only, never a user-facing error, always retried on the next interval. No exceptions to this.
- `electron-updater` must be a runtime `dependency` (not `devDependency`) and marked `external` in `scripts/build.js`'s esbuild config for `out/main/index.js`, the same way `playwright-core` already is — do not let esbuild try to bundle it.
- Check cadence for both paths: once ~10 seconds after the app is ready, then every 4 hours for as long as Echo keeps running.
- Every existing call site of `toast(message, kind)` in the renderer must keep working completely unchanged — the new third argument is optional and purely additive.

---

### Task 1: Pure version-comparison and platform-strategy logic

**Files:**
- Create: `src/main/update-version.ts`
- Test: `test/unit/update-version.test.ts`

**Interfaces:**
- Produces: `isNewer(current: string, latestTag: string): boolean`, `pickStrategy(platform: NodeJS.Platform): "auto-update" | "notify-only"` — both pure, no imports of `electron` or `electron-updater`, so Task 2's `updater.ts` can import them and they stay testable under the existing `node:test` unit runner (which externalizes `electron`/`playwright-core` from its esbuild bundle but does not need to touch `electron-updater` at all, because that import only ever appears in `updater.ts`, not here).

- [ ] **Step 1: Write the failing test**

Create `test/unit/update-version.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '../../src/main/update-version'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/main/update-version.ts`:

```ts
/**
 * Pure, electron-free version logic. Kept separate from updater.ts so it stays unit-testable
 * without importing electron or electron-updater.
 */

/** Compares dotted numeric versions ("1.2.0" or "v1.2.0"). Malformed input is never treated
 *  as newer, so a broken or unexpected feed response can never trigger an update. */
export function isNewer(current: string, latestTag: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latestTag);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Windows/Linux can auto-update without a signing cert; Mac's silent Squirrel.Mac update
 *  needs one this project doesn't have, so Mac only ever gets a "newer version exists" notice. */
export function pickStrategy(platform: NodeJS.Platform): "auto-update" | "notify-only" {
  return platform === "darwin" ? "notify-only" : "auto-update";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:unit`
Expected: PASS (all 4 new tests, plus every pre-existing unit test still green).

- [ ] **Step 5: Commit**

```bash
git add src/main/update-version.ts test/unit/update-version.test.ts
git commit -m "Add pure version-comparison logic for auto-update"
```

---

### Task 2: Backend updater module (electron-updater wiring + Mac checker)

**Files:**
- Create: `src/main/updater.ts`
- Modify: `src/shared/types.ts`
- Modify: `package.json`
- Modify: `scripts/build.js`

**Interfaces:**
- Consumes: `isNewer`, `pickStrategy` from `./update-version` (Task 1).
- Produces: `startUpdateChecks(onStatus: (status: UpdateStatus) => void): void`, `status(): UpdateStatus`, `applyUpdateNow(): void`, and the `UpdateStatus` type — all from `src/main/updater.ts`. Task 3 imports all four.

- [ ] **Step 1: Add the runtime dependency and publish config to `package.json`**

In the `"dependencies"` block, add `electron-updater` (keep alphabetical order):

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.17.0",
    "electron-updater": "^6.3.9",
    "mcp-remote": "^0.1.38",
    "playwright-core": "^1.62.1",
    "zod": "^3.25.0"
  },
```

In `"build"`, add a `"publish"` block right after `"copyright"` (electron-builder needs this to write `latest.yml` / `latest-linux.yml` / `app-update.yml` — the existing `dist:*` npm scripts keep `--publish never`, so this only controls metadata generation, not an actual upload; GitHub Actions' own `softprops/action-gh-release` step still does the real upload):

```json
    "appId": "com.echo.browser",
    "productName": "Echo",
    "copyright": "Copyright © 2026 Echo contributors",
    "publish": {
      "provider": "github",
      "owner": "krishngohel",
      "repo": "local-browser"
    },
    "artifactName": "Echo-Setup-${version}-${arch}.${ext}",
```

In `"build.asarUnpack"`, add `electron-updater` alongside `playwright-core` (belt-and-suspenders: `electron-updater` is pure JS, but this guarantees any native helper binary it might shell out to for NSIS differential patching is a real file on disk, not asar-packed):

```json
    "asarUnpack": [
      "node_modules/playwright-core/**",
      "node_modules/electron-updater/**"
    ],
```

Run: `npm install`
Expected: `electron-updater` appears in `node_modules/` and `package-lock.json` is updated.

- [ ] **Step 2: Externalize `electron-updater` in the main-process esbuild config**

In `scripts/build.js`, the first `esbuild.build` call (entry point `src/main/index.ts`) currently reads:

```js
  await esbuild.build({
    ...shared,
    entryPoints: ["src/main/index.ts"],
    platform: "node",
    target: "node20",
    outfile: "out/main/index.js",
    external: ["electron", "playwright-core"],
  });
```

Change the `external` array to:

```js
    external: ["electron", "playwright-core", "electron-updater"],
```

- [ ] **Step 3: Add `UpdateStatus` to the shared state type**

In `src/shared/types.ts`, add this type near `ActivityState` (just above `export type AppState = {`):

```ts
export type UpdateStatus = {
  state: "idle" | "checking" | "downloading" | "ready" | "mac-available" | "error";
  version?: string;
  releaseUrl?: string;
};
```

Then add a field to `AppState` (after the existing `bookmarks` field, before the closing brace):

```ts
  bookmarks: { count: number; activeBookmarked: boolean };
  updateStatus: UpdateStatus;
};
```

(replacing the existing `bookmarks: { count: number; activeBookmarked: boolean };\n};` lines with the two lines above).

- [ ] **Step 4: Write the updater module**

Create `src/main/updater.ts`:

```ts
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/types";
import { isNewer, pickStrategy } from "./update-version";

const REPO = "krishngohel/local-browser";
const CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let current: UpdateStatus = { state: "idle" };
let notify: (status: UpdateStatus) => void = () => {};

function setStatus(next: UpdateStatus): void {
  current = next;
  notify(current);
}

export function status(): UpdateStatus {
  return current;
}

autoUpdater.autoDownload = true;
autoUpdater.on("update-available", (info) => {
  setStatus({ state: "downloading", version: info.version });
});
autoUpdater.on("update-downloaded", (info) => {
  setStatus({ state: "ready", version: info.version });
});
autoUpdater.on("error", (err) => {
  console.error("[updater] electron-updater error:", err);
  setStatus({ state: "error" });
});

function checkWindowsOrLinux(): void {
  setStatus({ state: "checking" });
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[updater] check failed:", err);
    setStatus({ state: "error" });
  });
}

/** Mac has no code-signing cert, so Squirrel.Mac can't reliably apply a silent update. Poll
 *  GitHub's release feed directly and, if newer, point at the release page for a manual DMG
 *  reinstall — never download or touch anything on disk. */
async function checkMac(): Promise<void> {
  setStatus({ state: "checking" });
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = (await res.json()) as { tag_name: string; html_url: string };
    if (isNewer(app.getVersion(), data.tag_name)) {
      setStatus({
        state: "mac-available",
        version: data.tag_name.replace(/^v/, ""),
        releaseUrl: data.html_url,
      });
    } else {
      setStatus({ state: "idle" });
    }
  } catch (err) {
    console.error("[updater] mac version check failed:", err);
    setStatus({ state: "error" });
  }
}

/** Called once from index.ts on app ready. A no-op outside a packaged build: dev mode and the
 *  e2e test harness (ECHO_TEST=1) have no app-update.yml feed and must never make a network
 *  call or spawn an installer. */
export function startUpdateChecks(onStatus: (status: UpdateStatus) => void): void {
  notify = onStatus;
  if (!app.isPackaged) return;
  const check = pickStrategy(process.platform) === "auto-update" ? checkWindowsOrLinux : checkMac;
  setTimeout(check, CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}

/** Windows/Linux only. The renderer's Mac action opens releaseUrl directly via shell.openExternal
 *  in index.ts and never calls this. */
export function applyUpdateNow(): void {
  autoUpdater.quitAndInstall();
}
```

- [ ] **Step 5: Verify the build and a real packaged smoke test**

Run: `npm run build:prod`
Expected: no esbuild errors (confirms `electron-updater` is correctly externalized, not bundled).

Run: `npm run test:unit`
Expected: still all green — `updater.ts` is never imported by any test file, so this only re-confirms Task 1 didn't regress.

Run: `npm run dist:win` (takes ~1-2 minutes)
Expected: build succeeds and produces `dist-installer/Echo-Setup-*.exe` plus `dist-installer/latest.yml` and `dist-installer/*.blockmap` (the new metadata files — confirms the `publish` config took effect). Install it, launch it, and check `%APPDATA%\Echo\logs` or the console (via `--enable-logging` or just visual confirmation the app opens normally) for the absence of a "Cannot find module 'electron-updater'" error — that specific failure is the main integration risk this task introduces (esbuild external + asarUnpack must agree). Uninstall afterward if you don't want to keep a test copy around.

- [ ] **Step 6: Commit**

```bash
git add src/main/updater.ts src/shared/types.ts package.json package-lock.json scripts/build.js
git commit -m "Add the auto-update backend: electron-updater for Windows/Linux, GitHub API check-only for Mac"
```

---

### Task 3: IPC, preload, and renderer type surface

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/global.d.ts`

**Interfaces:**
- Consumes: `startUpdateChecks`, `applyUpdateNow`, `status` from `./updater` (Task 2).
- Produces: two new IPC channels (`update:apply`, `update:view-release`) and two new `window.lb` methods (`applyUpdate()`, `viewUpdateRelease()`) that Task 4's renderer code calls.

- [ ] **Step 1: Wire the main process**

In `src/main/index.ts`, add the import near the other local imports (after the `DialogPolicies` import):

```ts
import { DialogPolicies } from "./dialogs";
import { applyUpdateNow, startUpdateChecks, status as updateStatus } from "./updater";
```

In `getState()`, add the new field (after the existing `bookmarks` line):

```ts
    bookmarks: { count: bookmarks.list().length, activeBookmarked: bookmarks.has(hub.activeUrl()) },
    updateStatus: updateStatus(),
  };
}
```

In the `app.whenReady().then(async () => { ... })` block, right after the existing `activity.setOnChange(broadcast);` line, add:

```ts
    activity.setOnChange(broadcast);
    startUpdateChecks(broadcast);
```

Add the two new IPC handlers right after the existing `ipcMain.handle("profile:update", ...)` line:

```ts
  ipcMain.handle("profile:update", (_e, next: Partial<Profile>) => setProfile(next));
  ipcMain.handle("update:apply", () => {
    applyUpdateNow();
  });
  ipcMain.handle("update:view-release", () => {
    const url = updateStatus().releaseUrl;
    if (url) void shell.openExternal(url);
  });
```

- [ ] **Step 2: Expose the two actions in preload**

In `src/preload/index.ts`, add the import of `UpdateStatus` is not needed here (the type flows through `AppState`, already imported). Add two new entries right after the existing `updateProfile` line:

```ts
  getProfile: (): Promise<Profile> => ipcRenderer.invoke("profile:get"),
  updateProfile: (next: Partial<Profile>): Promise<Profile> => ipcRenderer.invoke("profile:update", next),
  applyUpdate: () => ipcRenderer.invoke("update:apply"),
  viewUpdateRelease: () => ipcRenderer.invoke("update:view-release"),
```

- [ ] **Step 3: Add the renderer type declarations**

In `src/renderer/global.d.ts`, add two new lines right after the existing `updateProfile` line:

```ts
      getProfile: () => Promise<Profile>;
      updateProfile: (next: Partial<Profile>) => Promise<Profile>;
      applyUpdate: () => Promise<void>;
      viewUpdateRelease: () => Promise<void>;
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit` (needs `NODE_OPTIONS=--max-old-space-size=8192` per this project's existing convention)
Expected: the same 4 pre-existing errors this project already has (in `browser.ts`/`preload/page.ts`), and no NEW errors introduced by this task's changes. `AppState`'s `updateStatus` field (added in Task 2) must not produce a new type error anywhere it's constructed or consumed.

Run: `npm run build:prod`
Expected: no esbuild errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/renderer/global.d.ts
git commit -m "Wire update-apply and view-release-page actions through IPC to the renderer"
```

---

### Task 4: Renderer UI — actionable toast and Settings status line

**Files:**
- Modify: `src/renderer/ui/toasts.ts`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/ui/settings.ts`
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: `window.lb.applyUpdate()`, `window.lb.viewUpdateRelease()` (Task 3); `AppState.updateStatus` (Task 2).
- Produces: `toast(message, kind?, action?)` — the `action` parameter is new and optional; every existing 1- and 2-argument call site keeps working unchanged.

- [ ] **Step 1: Add an optional action button to `toast()`**

Replace the full contents of `src/renderer/ui/toasts.ts` with:

```ts
import { h, maybe, svgIcon } from "./dom";
import { reserve } from "./overlay";

const MAX = 3;
const LIFE_MS = 3500;

type Kind = "info" | "ok" | "error";
type ToastAction = { label: string; onClick: () => void };

let timer = 0;

/**
 * Short confirmation in the top-right of the chrome. Announced politely, never focus-stealing.
 * With an `action`, the toast skips its normal auto-dismiss and stays until that action is
 * clicked — used for update-ready notices the user should be able to act on whenever they
 * notice it, not just within the next 3.5 seconds.
 */
export function toast(message: string, kind: Kind = "info", action?: ToastAction): void {
  const root = maybe<HTMLElement>("toasts");
  if (!root) return;
  const item = h("div", { class: `toast ${kind}` });
  if (kind !== "info") item.append(svgIcon(kind === "ok" ? "check" : "warning", "toast-icon"));
  item.append(h("span", { text: message }));
  if (action) {
    const btn = h("button", { class: "toast-action", text: action.label });
    btn.addEventListener("click", () => {
      action.onClick();
      item.remove();
      remeasureToasts();
    });
    item.append(btn);
  }
  root.append(item);
  while (root.children.length > MAX) root.firstElementChild?.remove();
  remeasureToasts();
  if (!action) {
    window.setTimeout(() => {
      item.remove();
      remeasureToasts();
    }, LIFE_MS);
  }
}

/**
 * Re-claims the strip a visible toast needs. `releaseAll` drops every claim at once (Escape,
 * a resize, leaving settings), and a toast outlives all three, so its owner has to ask again.
 */
export function remeasureToasts(): void {
  const root = maybe<HTMLElement>("toasts");
  if (!root) return;
  window.clearTimeout(timer);
  if (!root.children.length) {
    reserve("toasts", 0);
    return;
  }
  // One frame later the new node has a height.
  timer = window.setTimeout(() => {
    reserve("toasts", root.getBoundingClientRect().bottom);
  }, 0);
}
```

(The only changes from the current file: the `ToastAction` type, the new third parameter, the button-building block, and skipping the auto-dismiss timeout when `action` is present.)

- [ ] **Step 2: Style the action button and make toasts clickable**

In `src/renderer/styles.css`, find the `.toast {` rule (around line 1005) and add `pointer-events: auto;` to it (toasts currently sit inside a `pointer-events: none` container so nothing in them is clickable — needed now that a toast can hold a button):

```css
.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 380px;
  padding: 8px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  box-shadow: var(--shadow);
  color: var(--ink);
  font-size: 12.5px;
  animation: toast-in 150ms ease;
  pointer-events: auto;
}
```

Right after the existing `.toast-icon` / `.toast.error .toast-icon` rules, add:

```css
.toast-action {
  border: none;
  background: none;
  padding: 0;
  margin-left: 2px;
  font: inherit;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
  white-space: nowrap;
}

.toast-action:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Add the update card to the About section**

In `src/renderer/index.html`, inside `#section-about`, right after the existing `<p class="help" id="about-version">...</p>` line and before the Privacy Policy `<div class="card">`, add:

```html
            <p class="help" id="about-version">Version · Chromium-based · runs only on this computer</p>
            <div class="panel">
            <div class="card" id="update-card" hidden>
              <div>
                <h3>Update</h3>
                <p class="meta" id="update-status"></p>
              </div>
              <button class="chrome-btn filled" id="update-action">Restart now</button>
            </div>
            <div class="card">
              <div>
                <h3>Privacy Policy</h3>
```

(This only inserts the new `update-card` div between the existing `<p id="about-version">` line and the `<div class="panel">` / Privacy Policy card that were already there — the `<div class="panel">` opening tag itself is unchanged, just now followed by the new card before the existing ones.)

- [ ] **Step 4: Render the card and wire its click, in Settings**

In `src/renderer/ui/settings.ts`, inside `renderSettings()`, add this block right after the existing `text("about-version", ...)` line:

```ts
  text("about-version", `Version ${next.version} · Chromium-based · runs only on this computer`);

  const updateCard = document.getElementById("update-card");
  if (updateCard) {
    const ready = next.updateStatus.state === "ready";
    const macAvailable = next.updateStatus.state === "mac-available";
    updateCard.hidden = !ready && !macAvailable;
    if (ready || macAvailable) {
      text(
        "update-status",
        `Echo ${next.updateStatus.version} is ${ready ? "ready to install." : "available."}`,
      );
      const btn = document.getElementById("update-action") as HTMLButtonElement | null;
      if (btn) btn.textContent = ready ? "Restart now" : "View release";
    }
  }
```

In `initSettings()`, add the one-time click handler right after the existing `document.getElementById("profile-save")!.addEventListener(...)` line:

```ts
  document.getElementById("update-action")!.addEventListener("click", () => {
    if (latest?.updateStatus.state === "ready") void window.lb.applyUpdate();
    else if (latest?.updateStatus.state === "mac-available") void window.lb.viewUpdateRelease();
  });
```

- [ ] **Step 5: Fire a toast the moment an update becomes actionable**

`renderSettings()` only runs its DOM updates while the Settings page is open (`if (settingsEl().hidden) return;`), so the toast — which must reach the user whether or not Settings is open — is wired in `src/renderer/main.ts` instead, alongside the other always-on render steps.

Add a module-level key near the existing `let themeKey = "";` line:

```ts
let themeKey = "";
let updateToastKey = "";
```

Add this function after `renderRecordButton` (or anywhere else at module scope):

```ts
function renderUpdateToast(next: AppState): void {
  const s = next.updateStatus;
  const key = `${s.state}:${s.version ?? ""}`;
  if (key === updateToastKey) return;
  updateToastKey = key;
  if (s.state === "ready") {
    toast(`Echo ${s.version} is ready`, "info", {
      label: "Restart now",
      onClick: () => void window.lb.applyUpdate(),
    });
  } else if (s.state === "mac-available") {
    toast(`Echo ${s.version} is available`, "info", {
      label: "View release",
      onClick: () => void window.lb.viewUpdateRelease(),
    });
  }
}
```

Call it from `render()`, right after the existing `renderSettings(next);` line:

```ts
  renderSettings(next);
  renderUpdateToast(next);
}
```

- [ ] **Step 6: Manual visual verification**

Run: `npm run dev`
Once Echo is running, open Settings → About and confirm the update card is present but hidden (default `updateStatus.state` is `"idle"`).

Temporarily edit `src/main/updater.ts`'s module-level `current` initializer to `{ state: "ready", version: "9.9.9" }`, save, then quit Echo (tray → Quit) and run `npm run dev` again — it is a one-shot `build && electron .`, not a watch mode, so it must be manually re-run to pick up the edit. Confirm: a toast reading "Echo 9.9.9 is ready" appears with a working "Restart now" button, and the same status appears in Settings → About with its own "Restart now" button. Clicking either is expected to error harmlessly in dev mode (there is no real downloaded update to install) — that's fine, this step is only checking that the UI renders and wires correctly, not that `quitAndInstall()` succeeds outside a packaged build.

**Revert the temporary edit to `updater.ts` before committing** — the initializer must go back to `{ state: "idle" }`.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/ui/toasts.ts src/renderer/styles.css src/renderer/index.html src/renderer/ui/settings.ts src/renderer/main.ts
git commit -m "Add the update-ready toast and About-section status line"
```

---

### Task 5: Release pipeline artifacts and documentation

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`

**Interfaces:** None — this task only widens which already-built files get uploaded, and documents the new user-facing behavior. No code changes.

- [ ] **Step 1: Widen the Windows and Linux artifact globs**

In `.github/workflows/release.yml`, the `matrix.include` list currently reads:

```yaml
          - os: windows-latest
            dist: dist:win
            artifact: "dist-installer/Echo-Setup-*.exe"
          - os: macos-latest
            dist: dist:mac
            artifact: "dist-installer/Echo-*.dmg"
          - os: ubuntu-latest
            dist: dist:linux
            artifact: "dist-installer/Echo-*.AppImage"
```

Change the Windows and Linux entries to also upload the new auto-update metadata files (the `upload-artifact`/`download-artifact` steps already downstream use this same `artifact` value as a glob, and `softprops/action-gh-release`'s `files: dist/**` sweeps up everything landed there — so widening the glob here is the only change needed to get `latest.yml`/`latest-linux.yml`/`.blockmap` into the release). `actions/upload-artifact@v4` accepts multi-line glob patterns:

```yaml
          - os: windows-latest
            dist: dist:win
            artifact: |
              dist-installer/Echo-Setup-*.exe
              dist-installer/latest.yml
              dist-installer/Echo-Setup-*.exe.blockmap
          - os: macos-latest
            dist: dist:mac
            artifact: "dist-installer/Echo-*.dmg"
          - os: ubuntu-latest
            dist: dist:linux
            artifact: |
              dist-installer/Echo-*.AppImage
              dist-installer/latest-linux.yml
              dist-installer/Echo-*.AppImage.blockmap
```

The `path:` input of the corresponding `actions/upload-artifact@v4` step further down already reads `${{ matrix.artifact }}`, so no other line in the workflow needs to change — `path:` accepts the same multi-line glob syntax.

- [ ] **Step 2: Document the new behavior for users**

In `README.md`, in the **Day-to-day use** section, add a new bullet right after the existing `**Token usage and tool count:**` line:

```markdown
**Token usage and tool count:** Settings → Transfers. Turn off page photos, watch frames, or the skill tree on connect if you want fewer tokens. A fresh install exposes **40 tools**; Cursor and some other clients get unreliable past roughly 40 tools across every MCP server at once, so turn groups off if that cap bites. Reconnect the AI client after changing tool groups.

**Updates:** Windows and Linux check for a new version automatically and download it in the background — Settings → About shows "Restart now" once it's ready, and it never restarts on its own. Mac doesn't auto-update (no code-signing certificate yet); Settings → About shows a "View release" link when a newer version exists, for a manual reinstall.
```

- [ ] **Step 3: Document the new behavior for maintainers**

In `README.md`, in the **Build / release (maintainers)** section, update the existing paragraph:

```markdown
GitHub Actions (`.github/workflows/release.yml`) builds Windows, Mac, and Linux installers on **`v*` tags** (for example `git tag v1.0.0 && git push origin v1.0.0`). Manual **Run workflow** uploads artifacts to the Actions run but does not create a Release page.

Mac and Windows builds are unsigned unless signing secrets are configured.
```

to:

```markdown
GitHub Actions (`.github/workflows/release.yml`) builds Windows, Mac, and Linux installers on **`v*` tags** (for example `git tag v1.0.0 && git push origin v1.0.0`). Manual **Run workflow** uploads artifacts to the Actions run but does not create a Release page.

Mac and Windows builds are unsigned unless signing secrets are configured.

Every tagged release is also what installed Windows/Linux copies auto-update to (Mac gets a manual-reinstall notice instead — see Day-to-day use, above). There's no separate "ship an update" step: tagging a release *is* shipping the update.
```

- [ ] **Step 4: Verify**

There's no automated test for a documentation-only and CI-YAML-only change. Run `git diff .github/workflows/release.yml` and manually re-read it top to bottom once to confirm the YAML is still valid (correct indentation, no stray characters) — a broken workflow file only reveals itself the next time a tag is pushed, which is expensive to debug after the fact.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml README.md
git commit -m "Ship the new auto-update metadata files with releases, document the behavior"
```

---

## After all tasks: manual end-to-end verification

Not a task in the loop above because it requires publishing a real GitHub Release, which is a "ship it" action — do this only after all 5 tasks are reviewed and merged, and only with explicit go-ahead to actually tag a release:

1. Bump `version` in `package.json` to a throwaway patch (e.g. `1.1.1`), tag it, push the tag.
2. Confirm `.github/workflows/release.yml` runs green and the release page has `latest.yml`, `latest-linux.yml`, and the blockmap files alongside the installers.
3. On a machine with `v1.1.0` already installed: confirm it silently downloads `v1.1.1` within the check interval, the "Restart now" toast and Settings → About line both appear, and clicking either relaunches Echo as `v1.1.1`.
4. On Mac with `v1.1.0` installed: confirm the "View release" toast/Settings line appears and its link opens the correct release page, with no download attempted.
