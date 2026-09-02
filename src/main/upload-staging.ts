import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Staging for files the assistant authors itself: `upload_file` accepts inline content, this
 * module writes it under `uploads/` so Playwright can hand real paths to the page.
 *
 * Pure Node (no Electron import) so the rules — name sanitizing, size caps, stale cleanup —
 * are unit-testable.
 */

export type InlineUploadFile = {
  name: string;
  content: string;
  encoding?: "text" | "base64";
};

export const MAX_UPLOAD_FILES_PER_CALL = 10;
export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024;
/** Staged files only need to outlive the upload; a day is generous. */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A bare, Windows-safe file name: directory parts stripped, reserved and control characters
 * replaced, trailing dots and spaces removed. An empty result falls back to "file" so the
 * extension-less worst case still stages.
 */
export function sanitizeUploadName(name: string): string {
  const base = String(name).replace(/[/\\]+/g, "/").split("/").filter(Boolean).pop() ?? "";
  const cleaned = base
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  // CON, NUL, COM1... are device names on Windows, with or without an extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned)) return `_${cleaned}`.slice(0, 150);
  return cleaned.slice(0, 150);
}

function decode(file: InlineUploadFile): Buffer {
  if ((file.encoding ?? "text") === "text") return Buffer.from(file.content, "utf8");
  const stripped = file.content.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
    throw new Error(`"${file.name}" is not valid base64.`);
  }
  return Buffer.from(stripped, "base64");
}

/**
 * Writes the assistant's inline files into a fresh subfolder of `rootDir` and returns their
 * absolute paths, cleaning stale staging folders from earlier calls on the way in.
 */
export function stageUploadFiles(rootDir: string, files: InlineUploadFile[]): string[] {
  if (!files.length) return [];
  if (files.length > MAX_UPLOAD_FILES_PER_CALL) {
    throw new Error(`At most ${MAX_UPLOAD_FILES_PER_CALL} inline files per call.`);
  }
  cleanStaleStaging(rootDir);
  const buffers = files.map((file) => ({ name: sanitizeUploadName(file.name), data: decode(file) }));
  const oversized = buffers.find((b) => b.data.length > MAX_UPLOAD_FILE_BYTES);
  if (oversized) {
    throw new Error(`"${oversized.name}" is over the ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)} MB per-file limit.`);
  }
  const total = buffers.reduce((sum, b) => sum + b.data.length, 0);
  if (total > MAX_UPLOAD_TOTAL_BYTES) {
    throw new Error(`Inline files total over the ${MAX_UPLOAD_TOTAL_BYTES / (1024 * 1024)} MB per-call limit.`);
  }
  const dir = path.join(rootDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  return buffers.map(({ name, data }) => {
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      const dot = name.lastIndexOf(".");
      candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    }
    used.add(candidate.toLowerCase());
    const full = path.join(dir, candidate);
    fs.writeFileSync(full, data);
    return full;
  });
}

/** Deletes staging subfolders older than `maxAgeMs`. Failures are ignored: cleanup is best effort. */
export function cleanStaleStaging(rootDir: string, maxAgeMs = STAGING_MAX_AGE_MS): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(rootDir, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* a folder mid-delete or mid-write is fine to skip */
    }
  }
}
