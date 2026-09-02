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
