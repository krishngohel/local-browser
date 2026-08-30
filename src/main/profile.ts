import fs from "node:fs";
import path from "node:path";
import type { Profile } from "../shared/types";

export type { Profile };

export const DEFAULT_PROFILE: Profile = {
  fullName: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zip: "",
  country: "",
  linkedin: "",
  portfolio: "",
  github: "",
};

function file(dir?: string): string {
  const base = dir ?? (require("./paths").userDataDir() as string);
  return path.join(base, "profile.json");
}

export function getProfile(dir?: string): Profile {
  try {
    const raw = JSON.parse(fs.readFileSync(file(dir), "utf8")) as Partial<Profile>;
    return sanitize(raw, DEFAULT_PROFILE);
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export function setProfile(next: Partial<Profile>, dir?: string): Profile {
  const current = getProfile(dir);
  const merged = sanitize({ ...current, ...next }, current);
  fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
  fs.writeFileSync(file(dir), JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

// Invalid fields fall back to `fallback` (the prior stored value), not the hardcoded
// defaults, so a bad field in one setProfile() call doesn't clobber other fields
// that were validly set in a previous call. Mirrors settings.ts's sanitize().
function sanitize(p: Partial<Profile>, fallback: Profile): Profile {
  const out = { ...fallback };
  for (const key of Object.keys(DEFAULT_PROFILE) as (keyof Profile)[]) {
    if (typeof p[key] === "string") out[key] = p[key] as string;
  }
  return out;
}
