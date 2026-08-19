import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tokenPath } from "./paths";

export function getOrCreateToken(): string {
  const file = tokenPath();
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  return token;
}
