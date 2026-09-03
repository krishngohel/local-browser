import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseBoolReply,
  parseDirection,
  parseIntegerReply,
  parseNonNegativeInt,
  parseObjectName,
  recaptchaTilePrompt,
  stripCaptchaAnswer,
} from "../../src/main/captcha-vision";
import {
  captchaSolverReady,
  currentCaptchaKey,
  DEFAULT_CAPTCHA_SOLVER_PREFS,
  getCaptchaSolverPrefs,
  publicCaptchaSolverStatus,
  sanitizeCaptchaSolverPrefs,
  setCaptchaSolverPrefs,
  setCaptchaSolverPrefsDir,
} from "../../src/main/captcha-solver-prefs";

test("parseIntegerReply takes the first signed integer", () => {
  assert.equal(parseIntegerReply("134"), 134);
  assert.equal(parseIntegerReply("move 12 px"), 12);
  assert.equal(parseIntegerReply("-8"), -8);
  assert.equal(parseIntegerReply("no number"), null);
});

test("parseNonNegativeInt caps at 260", () => {
  assert.equal(parseNonNegativeInt("300"), 260);
  assert.equal(parseNonNegativeInt("-4"), 0);
  assert.equal(parseNonNegativeInt(" 42 "), 42);
});

test("parseBoolReply is exact true/false", () => {
  assert.equal(parseBoolReply("true"), true);
  assert.equal(parseBoolReply("TRUE\n"), true);
  assert.equal(parseBoolReply("false"), false);
  assert.equal(parseBoolReply("true-ish"), false);
});

test("parseObjectName lowercases and strips quotes", () => {
  assert.equal(parseObjectName(" Motorcycles "), "motorcycles");
  assert.equal(parseObjectName("'skip'"), "skip");
});

test("parseDirection reads + / -", () => {
  assert.equal(parseDirection("+"), 1);
  assert.equal(parseDirection("-"), -1);
  assert.equal(parseDirection("go +"), 1);
  assert.equal(parseDirection("nope"), null);
});

test("stripCaptchaAnswer drops spaces and punctuation", () => {
  assert.equal(stripCaptchaAnswer("A B-3!"), "AB3");
});

test("recaptcha tile prompt names the object", () => {
  assert.match(recaptchaTilePrompt("bicycles"), /bicycles/);
});

test("sanitizeCaptchaSolverPrefs drops bad keys and models", () => {
  const cleaned = sanitizeCaptchaSolverPrefs({
    enabled: true,
    provider: "gemini",
    openaiKey: "sk-ok",
    geminiKey: "bad\nkey",
    openaiModel: "gpt-4o",
    geminiModel: "gemini 2.5",
  });
  assert.equal(cleaned.enabled, true);
  assert.equal(cleaned.provider, "gemini");
  assert.equal(cleaned.openaiKey, "sk-ok");
  assert.equal(cleaned.geminiKey, DEFAULT_CAPTCHA_SOLVER_PREFS.geminiKey);
  assert.equal(cleaned.geminiModel, DEFAULT_CAPTCHA_SOLVER_PREFS.geminiModel);
});

test("prefs persist without leaking keys in publicStatus", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-captcha-"));
  setCaptchaSolverPrefsDir(dir);
  try {
    assert.equal(captchaSolverReady(), false);
    const saved = setCaptchaSolverPrefs({ enabled: true, provider: "openai", openaiKey: "sk-secret-test" });
    assert.equal(saved.openaiKey, "sk-secret-test");
    assert.equal(captchaSolverReady(), true);
    assert.equal(currentCaptchaKey(), "sk-secret-test");
    const pub = publicCaptchaSolverStatus();
    assert.equal(pub.enabled, true);
    assert.equal(pub.configured, true);
    assert.equal(pub.provider, "openai");
    assert.equal(JSON.stringify(pub).includes("sk-secret"), false);
    const raw = fs.readFileSync(path.join(dir, "captcha-solver.json"), "utf8");
    assert.match(raw, /sk-secret-test/);
    setCaptchaSolverPrefs({ openaiKey: "" });
    assert.equal(getCaptchaSolverPrefs().openaiKey, "");
    assert.equal(captchaSolverReady(), false);
  } finally {
    setCaptchaSolverPrefsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent provider is ready without a key; OpenAI is not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-captcha-agent-"));
  setCaptchaSolverPrefsDir(dir);
  try {
    setCaptchaSolverPrefs({ enabled: true, provider: "agent", openaiKey: "", geminiKey: "" });
    assert.equal(captchaSolverReady(), true);
    assert.equal(publicCaptchaSolverStatus().configured, true);
    assert.equal(publicCaptchaSolverStatus().provider, "agent");
    setCaptchaSolverPrefs({ provider: "openai" });
    assert.equal(captchaSolverReady(), false);
    assert.equal(publicCaptchaSolverStatus().configured, false);
  } finally {
    setCaptchaSolverPrefsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
