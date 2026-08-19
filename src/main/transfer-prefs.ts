import fs from "node:fs";
import path from "node:path";
import type { TransferPrefs } from "../shared/types";
import { userDataDir } from "./paths";

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
};

export const TOOL_GROUP_COUNTS = {
  always: 1,
  toolsBrowse: 16,
  toolsSee: 2,
  toolsSearch: 2,
  toolsDebug: 2,
  toolsTest: 5,
  toolsRecord: 5,
} as const;

export function enabledToolCount(prefs: TransferPrefs = getTransferPrefs()): number {
  let n = TOOL_GROUP_COUNTS.always;
  if (prefs.toolsBrowse) n += TOOL_GROUP_COUNTS.toolsBrowse;
  if (prefs.toolsSee) n += TOOL_GROUP_COUNTS.toolsSee;
  if (prefs.toolsSearch) n += TOOL_GROUP_COUNTS.toolsSearch;
  if (prefs.toolsDebug) n += TOOL_GROUP_COUNTS.toolsDebug;
  if (prefs.toolsTest) n += TOOL_GROUP_COUNTS.toolsTest;
  if (prefs.toolsRecord) n += TOOL_GROUP_COUNTS.toolsRecord;
  return n;
}

function prefsPath(): string {
  return path.join(userDataDir(), "transfer-prefs.json");
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
