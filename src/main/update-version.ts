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
