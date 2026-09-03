/**
 * Playwright orchestration for the opt-in vision CAPTCHA solver.
 *
 * Flows follow https://github.com/aydinnyunus/ai-captcha-bypass (reCAPTCHA v2 image tiles,
 * text OCR, GeeTest-style slider, recaptcha audio fallback). Invisible/score-based widgets
 * are not attempted — those still hand off to the person at the machine.
 */

import type { PwFrame, PwLocator, PwPage } from "./pw-bridge";
import { getCaptchaSolverPrefs } from "./captcha-solver-prefs";
import {
  askPuzzleCorrection,
  askPuzzleDistance,
  askRecaptchaObject,
  askTextOcr,
  askTileContains,
  transcribeCaptchaAudio,
} from "./captcha-vision";

export type CaptchaScan = { present: boolean; kind: string | null; visible: boolean };

export type CaptchaJudgment = {
  challengeId?: string;
  tiles?: number[];
  text?: string;
  offsetPx?: number;
  skip?: boolean;
};

export type CaptchaSolveResult = {
  ok: boolean;
  kind: string | null;
  method?: string;
  message: string;
  status?: "needs_judgment" | "done" | "handoff";
  challengeId?: string;
  tileCount?: number;
  prompt?: string;
  /** PNG screenshots for the connected assistant to judge. Never sent to OpenAI/Gemini. */
  images?: Buffer[];
};

const INVISIBLE_KINDS = new Set(["turnstile", "cloudflare"]);
const MAX_RECAPTCHA_ROUNDS = 5;
const MAX_SLIDER_ATTEMPTS = 3;
const MAX_TEXT_ATTEMPTS = 3;
const PENDING_TTL_MS = 120_000;

type PendingChallenge = { id: string; kind: string; created: number };
const pending = new Map<string, PendingChallenge>();

function prunePending(): void {
  const now = Date.now();
  for (const [id, item] of pending) {
    if (now - item.created > PENDING_TTL_MS) pending.delete(id);
  }
}

function storePending(kind: string): string {
  prunePending();
  const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  pending.set(id, { id, kind, created: Date.now() });
  return id;
}

export function hasJudgment(j?: CaptchaJudgment | null): boolean {
  if (!j) return false;
  if (j.skip) return true;
  if (typeof j.text === "string" && j.text.length > 0) return true;
  if (Array.isArray(j.tiles) && j.tiles.length > 0) return true;
  if (typeof j.offsetPx === "number" && Number.isFinite(j.offsetPx)) return true;
  return false;
}

/** Test seam: drop pending challenges. */
export function clearPendingChallenges(): void {
  pending.clear();
}

export function rememberPendingForTest(kind: string): string {
  return storePending(kind);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min = 200, max = 500): number {
  return min + Math.random() * (max - min);
}

async function locatorCount(loc: PwLocator): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return 0;
  }
}

async function firstVisible(root: PwPage | PwFrame, selector: string): Promise<PwLocator | null> {
  const loc = root.locator(selector);
  if ((await locatorCount(loc)) < 1) return null;
  const first = loc.first();
  try {
    if (await first.isVisible()) return first;
  } catch {
    /* visibility probe failed — treat as usable and let the click/screenshot decide */
    return first;
  }
  return null;
}

function frameMatching(page: PwPage, needle: string): PwFrame | undefined {
  return page.frames().find((f) => f.url().includes(needle));
}

function recaptchaAnchorFrame(page: PwPage): PwFrame | undefined {
  return (
    frameMatching(page, "api2/anchor") ??
    page.frames().find((f) => f.url().includes("recaptcha") && f.url().includes("/anchor"))
  );
}

function recaptchaChallengeFrame(page: PwPage): PwFrame | undefined {
  return (
    frameMatching(page, "api2/bframe") ??
    page.frames().find((f) => f.url().includes("recaptcha") && f.url().includes("bframe"))
  );
}

function handoff(kind: string | null, why: string): CaptchaSolveResult {
  return {
    ok: false,
    kind,
    status: "handoff",
    message: `${why} Ask the user to finish it in the Echo window, then wait_for.`,
  };
}

export async function solveCaptchaOnPage(
  page: PwPage,
  scan: CaptchaScan,
  judgment?: CaptchaJudgment,
): Promise<CaptchaSolveResult> {
  const kind = await classify(page, scan);
  if (!kind.present) {
    return { ok: true, kind: null, status: "done", message: "No CAPTCHA was found on this page." };
  }
  if (!kind.visible) {
    return handoff(
      kind.kind,
      "This is an invisible/score-based check, not a puzzle the vision solver can complete.",
    );
  }
  if (kind.kind && INVISIBLE_KINDS.has(kind.kind)) {
    return handoff(kind.kind, "Cloudflare Turnstile and similar interstitial checks cannot be solved by vision.");
  }
  if (kind.kind === "hcaptcha") {
    return handoff(kind.kind, "hCaptcha is not supported by the solver yet.");
  }
  try {
    const agent = getCaptchaSolverPrefs().provider === "agent";
    if (agent) {
      if (hasJudgment(judgment)) return await applyAgent(page, kind.kind ?? "recaptcha", judgment!);
      return await prepareAgent(page, kind.kind ?? "recaptcha");
    }
    if (kind.kind === "recaptcha") return await solveRecaptchaV2(page);
    if (kind.kind === "slider") return await solveSlider(page);
    if (kind.kind === "text") return await solveText(page);
    return handoff(kind.kind, `No solver path for ${kind.kind ?? "this"} challenge.`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, kind: kind.kind, status: "handoff", message };
  }
}

async function prepareAgent(page: PwPage, kind: string): Promise<CaptchaSolveResult> {
  if (kind === "recaptcha") return prepareRecaptcha(page);
  if (kind === "text") return prepareText(page);
  if (kind === "slider") return prepareSlider(page);
  return handoff(kind, `No solver path for ${kind} challenge.`);
}

async function applyAgent(page: PwPage, kind: string, judgment: CaptchaJudgment): Promise<CaptchaSolveResult> {
  prunePending();
  let useKind = kind;
  if (judgment.challengeId) {
    const item = pending.get(judgment.challengeId);
    if (!item) {
      return handoff(
        kind,
        "That challengeId expired or is unknown. Call captcha_solve again without tiles/text/offsetPx to get fresh images.",
      );
    }
    useKind = item.kind;
    pending.delete(judgment.challengeId);
  }
  if (useKind === "recaptcha") return applyRecaptcha(page, judgment);
  if (useKind === "text") return applyText(page, judgment);
  if (useKind === "slider") return applySlider(page, judgment);
  return handoff(useKind, `No solver path for ${useKind} challenge.`);
}

async function pngOf(loc: PwLocator): Promise<Buffer | null> {
  try {
    return await loc.screenshot({ type: "png", timeout: 8000 });
  } catch {
    return null;
  }
}

async function prepareRecaptcha(page: PwPage): Promise<CaptchaSolveResult> {
  const anchor = recaptchaAnchorFrame(page);
  if (anchor) {
    const already = await locatorCount(anchor.locator(".recaptcha-checkbox[aria-checked='true']"));
    if (already > 0) {
      return { ok: true, kind: "recaptcha", status: "done", method: "already-solved", message: "reCAPTCHA checkbox is already checked." };
    }
    const box = await firstVisible(anchor, ".recaptcha-checkbox-border, .recaptcha-checkbox, #recaptcha-anchor");
    if (box) {
      await box.click({ timeout: 8000 });
      await sleep(2000);
    }
  }
  const challenge = recaptchaChallengeFrame(page);
  if (!challenge) {
    const checked = anchor ? await locatorCount(anchor.locator(".recaptcha-checkbox[aria-checked='true']")) : 0;
    if (checked > 0) {
      return { ok: true, kind: "recaptcha", status: "done", method: "checkbox", message: "reCAPTCHA accepted the checkbox (no image challenge)." };
    }
    return handoff("recaptcha", "Opened reCAPTCHA but no image challenge appeared.");
  }
  const images: Buffer[] = [];
  const instruction = await firstVisible(challenge, ".rc-imageselect-instructions, .rc-imageselect-desc-wrapper");
  if (instruction) {
    const shot = await pngOf(instruction);
    if (shot) images.push(shot);
  }
  const tileCount = await locatorCount(challenge.locator("table[class*='rc-imageselect-table'] td"));
  for (let i = 0; i < tileCount; i++) {
    const shot = await pngOf(challenge.locator("table[class*='rc-imageselect-table'] td").nth(i));
    if (shot) images.push(shot);
  }
  const challengeId = storePending("recaptcha");
  return {
    ok: true,
    kind: "recaptcha",
    status: "needs_judgment",
    method: "agent",
    challengeId,
    tileCount,
    prompt:
      "This is a reCAPTCHA image challenge. Image 1 is the instruction bar (what to select). Images 2+ are tiles in row-major order, 0-indexed. Call captcha_solve again with { challengeId, tiles: [<indices that contain the object>] } or { challengeId, skip: true }.",
    message: `reCAPTCHA image grid is open (${tileCount} tiles). Look at the attached images and call captcha_solve with the tile indices to click.`,
    images,
  };
}

async function applyRecaptcha(page: PwPage, judgment: CaptchaJudgment): Promise<CaptchaSolveResult> {
  const challenge = recaptchaChallengeFrame(page);
  if (!challenge) {
    const anchor = recaptchaAnchorFrame(page);
    const checked = anchor ? await locatorCount(anchor.locator(".recaptcha-checkbox[aria-checked='true']")) : 0;
    if (checked > 0) {
      return { ok: true, kind: "recaptcha", status: "done", method: "checkbox", message: "reCAPTCHA checkbox is checked." };
    }
    return handoff("recaptcha", "The reCAPTCHA challenge iframe is gone.");
  }
  if (judgment.skip) {
    const verify = await firstVisible(challenge, "#recaptcha-verify-button");
    if (verify) await verify.click({ timeout: 8000 });
    await sleep(1500);
  } else {
    for (const i of judgment.tiles ?? []) {
      try {
        await challenge.locator("table[class*='rc-imageselect-table'] td").nth(i).click({ timeout: 4000 });
        await sleep(jitter());
      } catch {
        /* tile stale */
      }
    }
    const verify = await firstVisible(challenge, "#recaptcha-verify-button");
    if (verify) await verify.click({ timeout: 8000 });
    await sleep(1600);
  }
  const still = recaptchaChallengeFrame(page);
  const table = still ? await firstVisible(still, "table.rc-imageselect-table, table[class*='rc-imageselect-table']") : null;
  if (table) return prepareRecaptcha(page);
  return { ok: true, kind: "recaptcha", status: "done", method: "agent", message: "Applied the tile selection. Check the page; call captcha_solve again if a new grid appeared." };
}

async function prepareText(page: PwPage): Promise<CaptchaSolveResult> {
  const frame = await findTextCaptchaFrame(page);
  const root: PwPage | PwFrame = frame ?? page;
  const image =
    (await findTextCaptchaImage(root)) ??
    (frame ? await firstVisible(page, "iframe[id*='mtcaptcha'], iframe[src*='mtcaptcha']") : null);
  if (!image) return { ok: false, kind: "text", status: "handoff", message: "Found a text CAPTCHA hint but no image to read." };
  const png = await pngOf(image);
  const challengeId = storePending("text");
  return {
    ok: true,
    kind: "text",
    status: "needs_judgment",
    method: "agent",
    challengeId,
    prompt: "This is a text CAPTCHA. Read the characters in the image and call captcha_solve again with { challengeId, text: \"<answer>\" }.",
    message: "Text CAPTCHA image attached. Call captcha_solve with the text you read.",
    images: png ? [png] : [],
  };
}

async function applyText(page: PwPage, judgment: CaptchaJudgment): Promise<CaptchaSolveResult> {
  const answer = (judgment.text ?? "").trim();
  if (!answer) return { ok: false, kind: "text", status: "handoff", message: "No text answer was provided." };
  const frame = await findTextCaptchaFrame(page);
  const root: PwPage | PwFrame = frame ?? page;
  const input = await findTextInput(root);
  if (!input) {
    return {
      ok: false,
      kind: "text",
      method: "agent",
      message: `Read “${answer}” but could not find an input to type it into. Type it in the Echo window.`,
    };
  }
  await input.click({ timeout: 8000 });
  await input.fill(answer);
  return {
    ok: true,
    kind: "text",
    status: "done",
    method: "agent",
    message: `Filled the text CAPTCHA with “${answer}”. Submit the form if a button is still waiting.`,
  };
}

async function prepareSlider(page: PwPage): Promise<CaptchaSolveResult> {
  const start = await firstVisible(page, ".geetest_radar_tip, .geetest_wait_dot, .geetest_btn");
  if (start) {
    try {
      await start.click({ timeout: 4000 });
    } catch {
      /* already open */
    }
  }
  await sleep(2500);
  const windowEl = await firstVisible(page, ".geetest_window, .geetest_panel_box, [class*='geetest_window']");
  if (!windowEl) return { ok: false, kind: "slider", status: "handoff", message: "Found a slider CAPTCHA hint but no puzzle window." };
  const png = await pngOf(windowEl);
  const challengeId = storePending("slider");
  return {
    ok: true,
    kind: "slider",
    status: "needs_judgment",
    method: "agent",
    challengeId,
    prompt:
      "This is a slider puzzle CAPTCHA. Estimate the horizontal pixel distance to drag the handle into the slot (0–260). Call captcha_solve again with { challengeId, offsetPx: <integer> }.",
    message: "Slider puzzle attached. Call captcha_solve with offsetPx (pixels to drag right).",
    images: png ? [png] : [],
  };
}

async function applySlider(page: PwPage, judgment: CaptchaJudgment): Promise<CaptchaSolveResult> {
  const slider = await firstVisible(page, ".geetest_slider_button, [class*='geetest_slider_button']");
  if (!slider) return { ok: false, kind: "slider", status: "handoff", message: "No slider handle to drag." };
  const offset = Math.round(judgment.offsetPx ?? 0);
  await humanSlide(page, slider, offset);
  await sleep(1200);
  if (await sliderSucceeded(page)) {
    return { ok: true, kind: "slider", status: "done", method: "agent", message: `Moved the slider ${offset}px.` };
  }
  return {
    ok: false,
    kind: "slider",
    status: "handoff",
    method: "agent",
    message: `Moved the slider ${offset}px but it did not accept. Ask the user to finish it in the Echo window, or call captcha_solve again for a new screenshot.`,
  };
}

async function classify(page: PwPage, scan: CaptchaScan): Promise<CaptchaScan> {
  if (scan.present && scan.kind) return scan;
  if (frameMatching(page, "recaptcha") || (await locatorCount(page.locator("iframe[src*='recaptcha'], .g-recaptcha"))) > 0) {
    return { present: true, kind: "recaptcha", visible: true };
  }
  if (
    (await locatorCount(page.locator(".geetest_slider_button, .geetest_window, [class*='geetest_slider']"))) > 0
  ) {
    return { present: true, kind: "slider", visible: true };
  }
  if ((await findTextCaptchaImage(page)) || (await findTextCaptchaFrame(page))) {
    return { present: true, kind: "text", visible: true };
  }
  return scan;
}

async function findTextCaptchaImage(root: PwPage | PwFrame): Promise<PwLocator | null> {
  const selectors = [
    "img[src*='captcha' i]",
    "img[alt*='captcha' i]",
    "img[id*='captcha' i]",
    "img[class*='captcha' i]",
    "[class*='captcha'] img",
    "img[src*='Captcha']",
  ];
  for (const sel of selectors) {
    const found = await firstVisible(root, sel);
    if (found) return found;
  }
  return null;
}

async function findTextCaptchaFrame(page: PwPage): Promise<PwFrame | undefined> {
  return page.frames().find((f) => /mtcaptcha|captcha/i.test(f.url()) && !/recaptcha|hcaptcha|turnstile/i.test(f.url()));
}

async function findTextInput(root: PwPage | PwFrame): Promise<PwLocator | null> {
  const selectors = [
    "input[name*='captcha' i]",
    "input[id*='captcha' i]",
    "input[class*='captcha' i]",
    "input.mtcap-inputtext",
    "input[type='text']",
    "input:not([type])",
  ];
  for (const sel of selectors) {
    const found = await firstVisible(root, sel);
    if (found) return found;
  }
  return null;
}

async function solveText(page: PwPage): Promise<CaptchaSolveResult> {
  const frame = await findTextCaptchaFrame(page);
  const root: PwPage | PwFrame = frame ?? page;
  for (let attempt = 0; attempt < MAX_TEXT_ATTEMPTS; attempt++) {
    const image = (await findTextCaptchaImage(root)) ?? (frame ? await firstVisible(page, "iframe[id*='mtcaptcha'], iframe[src*='mtcaptcha']") : null);
    if (!image) {
      return { ok: false, kind: "text", message: "Found a text CAPTCHA hint but no image to read." };
    }
    const png = await image.screenshot({ type: "png", timeout: 8000 });
    const answer = (await askTextOcr(png)).trim();
    if (!answer) continue;
    const input = await findTextInput(root);
    if (!input) {
      return {
        ok: false,
        kind: "text",
        method: "ocr",
        message: `Read “${answer}” but could not find an input to type it into. Type it in the Echo window.`,
      };
    }
    await input.click({ timeout: 8000 });
    await input.fill(answer);
    await sleep(400);
    return {
      ok: true,
      kind: "text",
      method: "ocr",
      message: `Filled the text CAPTCHA with “${answer}”. Submit the form if a button is still waiting.`,
    };
  }
  return { ok: false, kind: "text", method: "ocr", message: "Could not read the text CAPTCHA after 3 attempts." };
}

async function solveRecaptchaV2(page: PwPage): Promise<CaptchaSolveResult> {
  const anchor = recaptchaAnchorFrame(page);
  if (anchor) {
    const already = await locatorCount(anchor.locator(".recaptcha-checkbox[aria-checked='true']"));
    if (already > 0) {
      return { ok: true, kind: "recaptcha", method: "already-solved", message: "reCAPTCHA checkbox is already checked." };
    }
    const box = await firstVisible(anchor, ".recaptcha-checkbox-border, .recaptcha-checkbox, #recaptcha-anchor");
    if (box) {
      await box.click({ timeout: 8000 });
      await sleep(2000);
    }
  }

  for (let round = 0; round < MAX_RECAPTCHA_ROUNDS; round++) {
    const challenge = recaptchaChallengeFrame(page);
    if (!challenge) {
      const checked = anchor ? await locatorCount(anchor.locator(".recaptcha-checkbox[aria-checked='true']")) : 0;
      if (checked > 0) {
        return { ok: true, kind: "recaptcha", method: "checkbox", message: "reCAPTCHA accepted the checkbox (no image challenge)." };
      }
      break;
    }

    const audio = await firstVisible(challenge, "#audio-source, audio#audio-source, .rc-audiochallenge-tdownload-link");
    const table = await firstVisible(challenge, "table.rc-imageselect-table, table[class*='rc-imageselect-table']");
    if (!table && audio) {
      const audioOk = await solveRecaptchaAudio(challenge);
      if (audioOk) {
        return { ok: true, kind: "recaptcha", method: "audio", message: "Solved the reCAPTCHA audio challenge." };
      }
    }
    if (!table) {
      const skipAudio = await firstVisible(challenge, "#recaptcha-audio-button");
      if (skipAudio && round >= 2) {
        await skipAudio.click({ timeout: 8000 });
        await sleep(1500);
        continue;
      }
      const checked = anchor ? await locatorCount(anchor.locator(".recaptcha-checkbox[aria-checked='true']")) : 0;
      if (checked > 0) {
        return { ok: true, kind: "recaptcha", method: "checkbox", message: "reCAPTCHA checkbox is checked." };
      }
      await sleep(800);
      continue;
    }

    const instruction = await firstVisible(challenge, ".rc-imageselect-instructions, .rc-imageselect-desc-wrapper");
    if (!instruction) {
      await sleep(500);
      continue;
    }
    const instructionPng = await instruction.screenshot({ type: "png", timeout: 8000 });
    const objectName = await askRecaptchaObject(instructionPng);
    if (!objectName || objectName === "skip") {
      const verify = await firstVisible(challenge, "#recaptcha-verify-button");
      if (verify) await verify.click({ timeout: 8000 });
      await sleep(1500);
      continue;
    }

    const tileCount = await locatorCount(challenge.locator("table[class*='rc-imageselect-table'] td"));
    const tiles: { index: number; png: Buffer }[] = [];
    for (let i = 0; i < tileCount; i++) {
      const tile = challenge.locator("table[class*='rc-imageselect-table'] td").nth(i);
      try {
        tiles.push({ index: i, png: await tile.screenshot({ type: "png", timeout: 8000 }) });
      } catch {
        /* tile went stale */
      }
    }
    const hits = await Promise.all(tiles.map(async (t) => ({ index: t.index, hit: await askTileContains(t.png, objectName) })));
    const toClick = hits.filter((h) => h.hit).map((h) => h.index);
    for (const i of toClick) {
      try {
        await challenge.locator("table[class*='rc-imageselect-table'] td").nth(i).click({ timeout: 4000 });
        await sleep(jitter());
      } catch {
        /* already selected or replaced */
      }
    }
    const verify = await firstVisible(challenge, "#recaptcha-verify-button");
    if (verify) {
      await verify.click({ timeout: 8000 });
      await sleep(1600);
      try {
        const disabled = await verify.getAttribute("disabled");
        if (disabled !== null) {
          return { ok: true, kind: "recaptcha", method: "image-tiles", message: `Solved the reCAPTCHA image grid (${objectName}).` };
        }
      } catch {
        /* button replaced */
      }
    }
    const checked = anchor ? await locatorCount(anchor.locator(".recaptcha-checkbox[aria-checked='true']")) : 0;
    if (checked > 0) {
      return { ok: true, kind: "recaptcha", method: "image-tiles", message: `Solved the reCAPTCHA image grid (${objectName}).` };
    }
  }

  return {
    ok: false,
    kind: "recaptcha",
    method: "image-tiles",
    message: "Could not finish the reCAPTCHA image challenge. Ask the user to complete it in the Echo window.",
  };
}

async function solveRecaptchaAudio(challenge: PwFrame): Promise<boolean> {
  try {
    const audioBtn = await firstVisible(challenge, "#recaptcha-audio-button");
    if (audioBtn) {
      await audioBtn.click({ timeout: 8000 });
      await sleep(1500);
    }
    const src =
      (await challenge.locator("#audio-source, audio").first().getAttribute("src")) ||
      (await challenge.locator(".rc-audiochallenge-tdownload-link").first().getAttribute("href"));
    if (!src) return false;
    const res = await fetch(src, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return false;
    const mime = res.headers.get("content-type") || "audio/mpeg";
    const bytes = Buffer.from(await res.arrayBuffer());
    const answer = await transcribeCaptchaAudio(bytes, mime.split(";")[0] || "audio/mpeg");
    if (!answer) return false;
    const input = await firstVisible(challenge, "#audio-response, input#audio-response");
    if (!input) return false;
    await input.fill(answer);
    const verify = await firstVisible(challenge, "#recaptcha-verify-button");
    if (verify) await verify.click({ timeout: 8000 });
    await sleep(1500);
    return true;
  } catch {
    return false;
  }
}

async function solveSlider(page: PwPage): Promise<CaptchaSolveResult> {
  const start = await firstVisible(page, ".geetest_radar_tip, .geetest_wait_dot, .geetest_btn");
  if (start) {
    try {
      await start.click({ timeout: 4000 });
    } catch {
      /* already open */
    }
  }
  await sleep(2500);
  const provider = getCaptchaSolverPrefs().provider;
  const scale = provider === "gemini" ? 0.791 : 1;

  for (let attempt = 0; attempt < MAX_SLIDER_ATTEMPTS; attempt++) {
    const windowEl = await firstVisible(page, ".geetest_window, .geetest_panel_box, [class*='geetest_window']");
    const slider = await firstVisible(page, ".geetest_slider_button, [class*='geetest_slider_button']");
    if (!windowEl || !slider) {
      return { ok: false, kind: "slider", message: "Found a slider CAPTCHA hint but no handle to drag." };
    }
    const png = await windowEl.screenshot({ type: "png", timeout: 8000 });
    const raw = await askPuzzleDistance(png);
    if (raw === null) {
      await refreshSlider(page);
      continue;
    }
    const offset = Math.round(raw * scale);
    await humanSlide(page, slider, offset);
    await sleep(1200);
    if (await sliderSucceeded(page)) {
      return { ok: true, kind: "slider", method: "drag", message: `Moved the slider ${offset}px.` };
    }
    const after = await windowEl.screenshot({ type: "png", timeout: 8000 });
    const correction = await askPuzzleCorrection(after);
    if (correction && correction !== 0) {
      await humanSlide(page, slider, correction);
      await sleep(1200);
      if (await sliderSucceeded(page)) {
        return { ok: true, kind: "slider", method: "drag+correction", message: `Moved the slider ${offset + correction}px.` };
      }
    }
    await refreshSlider(page);
  }
  return {
    ok: false,
    kind: "slider",
    method: "drag",
    message: "Could not align the slider puzzle. Ask the user to complete it in the Echo window.",
  };
}

async function refreshSlider(page: PwPage): Promise<void> {
  const refresh = await firstVisible(page, ".geetest_refresh_1, .geetest_refresh, [class*='geetest_refresh']");
  if (refresh) {
    try {
      await refresh.click({ timeout: 4000 });
      await sleep(2000);
    } catch {
      /* ignore */
    }
  }
}

async function sliderSucceeded(page: PwPage): Promise<boolean> {
  const tip = await firstVisible(page, ".geetest_success_radar_tip_content, .geetest_success");
  if (!tip) return false;
  try {
    const text = (await tip.innerText()).toLowerCase();
    return text.includes("success") || text.includes("verified");
  } catch {
    return true;
  }
}

async function humanSlide(page: PwPage, slider: PwLocator, offset: number): Promise<void> {
  const box = await slider.boundingBox({ timeout: 8000 });
  if (!box) throw new Error("Slider handle has no bounding box.");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const part1 = offset * (0.7 + Math.random() * 0.1);
  const part2 = offset * (0.15 + Math.random() * 0.1);
  const part3 = offset - part1 - part2;
  await page.mouse.move(startX, startY, { steps: 8 });
  await page.mouse.down();
  await sleep(jitter(300, 400));
  await page.mouse.move(startX + part1, startY, { steps: 18 });
  await sleep(jitter(250, 400));
  await page.mouse.move(startX + part1 + part2, startY, { steps: 10 });
  await sleep(jitter(250, 400));
  await page.mouse.move(startX + offset, startY, { steps: 6 });
  await sleep(jitter(250, 400));
  await page.mouse.up();
  void part3;
}
