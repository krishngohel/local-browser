import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_UPLOAD_FILES_PER_CALL,
  MAX_UPLOAD_FILE_BYTES,
  cleanStaleStaging,
  sanitizeUploadName,
  stageUploadFiles,
} from "../../src/main/upload-staging";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "echo-uploads-"));

test("sanitizeUploadName strips directories and Windows-hostile characters", () => {
  assert.equal(sanitizeUploadName("report.csv"), "report.csv");
  assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeUploadName("C:\\Users\\me\\notes.txt"), "notes.txt");
  assert.equal(sanitizeUploadName('a<b>c:d"e|f?g*h.txt'), "a_b_c_d_e_f_g_h.txt");
  assert.equal(sanitizeUploadName("trailing. . ."), "trailing");
  assert.equal(sanitizeUploadName(""), "file");
  assert.equal(sanitizeUploadName("..."), "file");
  assert.equal(sanitizeUploadName("CON.txt"), "_CON.txt", "Windows device names are prefixed");
  assert.ok(sanitizeUploadName(`${"x".repeat(400)}.txt`).length <= 150);
});

test("stageUploadFiles writes text and base64 content and returns real paths", () => {
  const dir = tmp();
  const [a, b] = stageUploadFiles(dir, [
    { name: "hello.txt", content: "hi there" },
    { name: "bin.dat", content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" },
  ]);
  assert.equal(fs.readFileSync(a, "utf8"), "hi there");
  assert.deepEqual([...fs.readFileSync(b)], [1, 2, 3]);
  assert.equal(path.basename(a), "hello.txt");
  assert.ok(a.startsWith(dir), "staged inside the given root");
});

test("stageUploadFiles suffixes name collisions instead of overwriting", () => {
  const dir = tmp();
  const staged = stageUploadFiles(dir, [
    { name: "same.txt", content: "one" },
    { name: "same.txt", content: "two" },
    { name: "Same.txt", content: "three" },
  ]);
  assert.equal(new Set(staged).size, 3);
  assert.deepEqual(staged.map((p) => fs.readFileSync(p, "utf8")), ["one", "two", "three"]);
  assert.equal(path.basename(staged[1]), "same (2).txt");
});

test("stageUploadFiles rejects bad base64, oversized files, and too many files", () => {
  const dir = tmp();
  assert.throws(() => stageUploadFiles(dir, [{ name: "x", content: "not base64!!", encoding: "base64" }]), /not valid base64/);
  const big = { name: "big.bin", content: "a".repeat(MAX_UPLOAD_FILE_BYTES + 1) };
  assert.throws(() => stageUploadFiles(dir, [big]), /per-file limit/);
  const many = Array.from({ length: MAX_UPLOAD_FILES_PER_CALL + 1 }, (_, i) => ({ name: `f${i}`, content: "x" }));
  assert.throws(() => stageUploadFiles(dir, many), /At most/);
});

test("cleanStaleStaging removes only old staging folders", () => {
  const dir = tmp();
  const fresh = stageUploadFiles(dir, [{ name: "keep.txt", content: "k" }])[0];
  const old = path.join(dir, "1-old");
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, "gone.txt"), "g");
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  cleanStaleStaging(dir);
  assert.ok(!fs.existsSync(old), "stale folder deleted");
  assert.ok(fs.existsSync(fresh), "fresh staging kept");
  cleanStaleStaging(path.join(dir, "does-not-exist"));
});
