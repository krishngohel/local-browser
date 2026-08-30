import fs from "node:fs";
import path from "node:path";
import type { TransferPrefs } from "../shared/types";

export const DEFAULT_TRANSFER_PREFS: TransferPrefs = {
  snapshotPhoto: true,
  screenshotPhoto: true,
  watchFrames: true,
  readableText: true,
  skillTreeOnConnect: true,
  toolsBrowse: true,
  toolsSee: true,
  toolsSearch: true,
  toolsDebug: true,
  toolsTest: true,
  toolsRecord: true,
  toolsRead: true,
  toolsInteract: false,
  toolsState: false,
  toolsQa: false,
};

export const TOOL_GROUP_COUNTS = {
  always: 1,
  toolsBrowse: 15,
  toolsSee: 2,
  toolsSearch: 2,
  toolsDebug: 2,
  toolsTest: 5,
  toolsRecord: 5,
  toolsRead: 9,
  toolsInteract: 11,
  toolsState: 14,
  toolsQa: 9,
} as const;

export function enabledToolCount(prefs: TransferPrefs = getTransferPrefs(), evaluateEnabled = false): number {
  let n = TOOL_GROUP_COUNTS.always;
  for (const key of Object.keys(TOOL_GROUP_COUNTS) as (keyof typeof TOOL_GROUP_COUNTS)[]) {
    if (key !== "always" && prefs[key]) n += TOOL_GROUP_COUNTS[key];
  }
  if (prefs.toolsInteract && evaluateEnabled) n += 1;
  return n;
}

let overrideDir: string | null = null;
export function setTransferPrefsDir(dir: string | null): void { overrideDir = dir; }
function prefsPath(): string {
  const dir = overrideDir ?? require("./paths").userDataDir();
  return path.join(dir, "transfer-prefs.json");
}

export function getTransferPrefs(): TransferPrefs {
  try {
    const raw = JSON.parse(fs.readFileSync(prefsPath(), "utf8")) as Partial<TransferPrefs>;
    return { ...DEFAULT_TRANSFER_PREFS, ...raw };
  } catch {
    return { ...DEFAULT_TRANSFER_PREFS };
  }
}

export function setTransferPrefs(next: Partial<TransferPrefs>): TransferPrefs {
  const current = getTransferPrefs();
  const merged: TransferPrefs = { ...current };
  for (const key of Object.keys(DEFAULT_TRANSFER_PREFS) as (keyof TransferPrefs)[]) {
    if (typeof next[key] === "boolean") merged[key] = next[key]!;
  }
  fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
  fs.writeFileSync(prefsPath(), JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}
