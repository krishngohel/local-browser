import { app } from "electron";
import type { UpdateStatus } from "../shared/types";
import { isNewer, pickStrategy } from "./update-version";

// Read the repo slug from the same place electron-builder's publish config lives, so a future
// repo rename only needs to change package.json once instead of also updating this string.
const pkg = require("../../package.json") as {
  build?: { publish?: { owner?: string; repo?: string } };
};
const REPO = `${pkg.build?.publish?.owner ?? "krishngohel"}/${pkg.build?.publish?.repo ?? "local-browser"}`;

const CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAC_FETCH_TIMEOUT_MS = 15_000;

let current: UpdateStatus = { state: "idle" };
let notify: (status: UpdateStatus) => void = () => {};

// Populated lazily by startUpdateChecks on the Windows/Linux path only, after the
// app.isPackaged guard. Stays null on Mac, in dev, in the ECHO_TEST harness, and if the module
// ever fails to load, so checkWindowsOrLinux/applyUpdateNow can no-op instead of throwing.
let autoUpdater: typeof import("electron-updater").autoUpdater | null = null;

function setStatus(next: UpdateStatus): void {
  current = next;
  notify(current);
}

export function status(): UpdateStatus {
  return current;
}

/** A terminal, actionable status the user hasn't acted on yet. A routine re-check must never
 *  clobber this: if it did, an update already sitting downloaded on disk (or a Mac notice
 *  already shown) could become permanently invisible the moment the next check fails. */
function hasActionableStatus(): boolean {
  return current.state === "ready" || current.state === "mac-available";
}

function checkWindowsOrLinux(): void {
  if (!autoUpdater || hasActionableStatus()) return;
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
  if (hasActionableStatus()) return;
  setStatus({ state: "checking" });
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(MAC_FETCH_TIMEOUT_MS),
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

/** Loads electron-updater and wires up its listeners. Called only from startUpdateChecks,
 *  only on Windows/Linux, only after the app.isPackaged guard has already passed — dev mode,
 *  the e2e test harness (ECHO_TEST=1), and macOS must never pay for this module's resolution
 *  or native construction. Dynamic `require` (rather than a static top-level import) plus a
 *  try/catch means a future asar/build-config drift or Node mismatch in electron-updater fails
 *  soft into an error status instead of crashing the main process before the window opens. */
function loadAutoUpdater(): boolean {
  try {
    const mod = require("electron-updater") as typeof import("electron-updater");
    autoUpdater = mod.autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-available", (info) => {
      setStatus({ state: "downloading", version: info.version });
    });
    autoUpdater.on("update-not-available", () => {
      setStatus({ state: "idle" });
    });
    autoUpdater.on("update-downloaded", (info) => {
      setStatus({ state: "ready", version: info.version });
    });
    autoUpdater.on("error", (err) => {
      console.error("[updater] electron-updater error:", err);
      setStatus({ state: "error" });
    });
    return true;
  } catch (err) {
    console.error("[updater] failed to load electron-updater:", err);
    autoUpdater = null;
    return false;
  }
}

/** Called once from index.ts on app ready. A no-op outside a packaged build: dev mode and the
 *  e2e test harness (ECHO_TEST=1) have no app-update.yml feed and must never make a network
 *  call or spawn an installer. */
export function startUpdateChecks(onStatus: (status: UpdateStatus) => void): void {
  notify = onStatus;
  if (!app.isPackaged) return;

  if (pickStrategy(process.platform) !== "auto-update") {
    setTimeout(checkMac, CHECK_DELAY_MS);
    setInterval(checkMac, CHECK_INTERVAL_MS);
    return;
  }

  if (!loadAutoUpdater()) {
    setStatus({ state: "error" });
    return;
  }
  setTimeout(checkWindowsOrLinux, CHECK_DELAY_MS);
  setInterval(checkWindowsOrLinux, CHECK_INTERVAL_MS);
}

/** Windows/Linux only. The renderer's Mac action opens releaseUrl directly via shell.openExternal
 *  in index.ts and never calls this. Guarded so a stale UI (a toast/button that hasn't yet
 *  reflected a state change) can't trigger quitAndInstall outside the one state it's valid in. */
export function applyUpdateNow(): void {
  if (current.state !== "ready") return;
  autoUpdater?.quitAndInstall();
}
