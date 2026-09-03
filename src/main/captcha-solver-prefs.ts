import fs from "node:fs";
import path from "node:path";
import type { CaptchaSolverPublic } from "../shared/types";

export type CaptchaSolverProvider = "agent" | "openai" | "gemini";

export type CaptchaSolverPrefs = {
  enabled: boolean;
  provider: CaptchaSolverProvider;
  openaiKey: string;
  geminiKey: string;
  openaiModel: string;
  geminiModel: string;
};

export type CaptchaSolverPatch = {
  enabled?: boolean;
  provider?: CaptchaSolverProvider;
  openaiKey?: string;
  geminiKey?: string;
  openaiModel?: string;
  geminiModel?: string;
};

export const DEFAULT_CAPTCHA_SOLVER_PREFS: CaptchaSolverPrefs = {
  enabled: false,
  provider: "agent",
  openaiKey: "",
  geminiKey: "",
  openaiModel: "gpt-4o",
  geminiModel: "gemini-2.5-pro",
};

const KEY_MAX = 512;
const MODEL_MAX = 80;
const MODEL_OK = /^[a-zA-Z0-9._:-]+$/;

let overrideDir: string | null = null;

export function setCaptchaSolverPrefsDir(dir: string | null): void {
  overrideDir = dir;
}

function prefsPath(): string | null {
  try {
    const dir = overrideDir ?? (require("./paths").userDataDir() as string);
    return path.join(dir, "captcha-solver.json");
  } catch {
    return null;
  }
}

function clampKey(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, KEY_MAX);
  if (/[\r\n]/.test(trimmed)) return fallback;
  return trimmed;
}

function clampModel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, MODEL_MAX);
  return MODEL_OK.test(trimmed) ? trimmed : fallback;
}

export function sanitizeCaptchaSolverPrefs(
  raw: Partial<CaptchaSolverPrefs> | null | undefined,
  fallback: CaptchaSolverPrefs = DEFAULT_CAPTCHA_SOLVER_PREFS,
): CaptchaSolverPrefs {
  const s = raw ?? {};
  const provider: CaptchaSolverProvider =
    s.provider === "gemini" || s.provider === "openai" || s.provider === "agent" ? s.provider : fallback.provider;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : fallback.enabled,
    provider,
    openaiKey: clampKey(s.openaiKey, fallback.openaiKey),
    geminiKey: clampKey(s.geminiKey, fallback.geminiKey),
    openaiModel: clampModel(s.openaiModel, fallback.openaiModel),
    geminiModel: clampModel(s.geminiModel, fallback.geminiModel),
  };
}

export function getCaptchaSolverPrefs(): CaptchaSolverPrefs {
  const file = prefsPath();
  if (!file) return { ...DEFAULT_CAPTCHA_SOLVER_PREFS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CaptchaSolverPrefs>;
    return sanitizeCaptchaSolverPrefs(raw, DEFAULT_CAPTCHA_SOLVER_PREFS);
  } catch {
    return { ...DEFAULT_CAPTCHA_SOLVER_PREFS };
  }
}

export function setCaptchaSolverPrefs(next: CaptchaSolverPatch): CaptchaSolverPrefs {
  const current = getCaptchaSolverPrefs();
  const merged = sanitizeCaptchaSolverPrefs({ ...current, ...next }, current);
  const file = prefsPath();
  if (!file) return merged;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows ignores POSIX modes; the write still succeeded. */
  }
  return merged;
}

export function currentCaptchaKey(prefs: CaptchaSolverPrefs = getCaptchaSolverPrefs()): string {
  if (prefs.provider === "gemini") return prefs.geminiKey;
  if (prefs.provider === "openai") return prefs.openaiKey;
  return "";
}

export function currentCaptchaModel(prefs: CaptchaSolverPrefs = getCaptchaSolverPrefs()): string {
  return prefs.provider === "gemini" ? prefs.geminiModel : prefs.openaiModel;
}

/** Solver is usable: toggle on, and either the connected assistant or a saved API key. */
export function captchaSolverReady(): boolean {
  const prefs = getCaptchaSolverPrefs();
  if (!prefs.enabled) return false;
  if (prefs.provider === "agent") return true;
  return currentCaptchaKey(prefs).length > 0;
}

/** Status that is safe to broadcast to the renderer and MCP clients — no secrets. */
export function publicCaptchaSolverStatus(): CaptchaSolverPublic {
  const prefs = getCaptchaSolverPrefs();
  return {
    enabled: prefs.enabled,
    configured: prefs.provider === "agent" || currentCaptchaKey(prefs).length > 0,
    provider: prefs.provider,
    openaiModel: prefs.openaiModel,
    geminiModel: prefs.geminiModel,
  };
}
