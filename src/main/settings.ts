import fs from "node:fs";
import path from "node:path";
import type { AppSettings } from "../shared/types";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  compactChrome: false,
  homeUrl: "https://www.google.com/",
  evaluateEnabled: false,
};

function file(dir?: string): string {
  const base = dir ?? (require("./paths").userDataDir() as string);
  return path.join(base, "settings.json");
}

export function getSettings(dir?: string): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file(dir), "utf8")) as Partial<AppSettings>;
    return sanitize(raw, DEFAULT_SETTINGS);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(next: Partial<AppSettings>, dir?: string): AppSettings {
  const current = getSettings(dir);
  const merged = sanitize({ ...current, ...next }, current);
  fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
  fs.writeFileSync(file(dir), JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

// Invalid fields fall back to `fallback` (the prior stored value), not the hardcoded
// defaults, so a bad field in one setSettings() call doesn't clobber other fields
// that were validly set in a previous call.
function sanitize(s: Partial<AppSettings>, fallback: AppSettings): AppSettings {
  return {
    theme: s.theme === "light" || s.theme === "dark" || s.theme === "system" ? s.theme : fallback.theme,
    compactChrome: typeof s.compactChrome === "boolean" ? s.compactChrome : fallback.compactChrome,
    homeUrl: typeof s.homeUrl === "string" && /^https?:\/\//.test(s.homeUrl) ? s.homeUrl : fallback.homeUrl,
    evaluateEnabled: typeof s.evaluateEnabled === "boolean" ? s.evaluateEnabled : fallback.evaluateEnabled,
  };
}
