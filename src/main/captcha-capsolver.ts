/**
 * CapSolver token client for the opt-in CAPTCHA solver.
 *
 * Token-based challenges (reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile) cannot be solved
 * by looking at pixels — the site wants a signed token from the CAPTCHA vendor. CapSolver
 * (https://docs.capsolver.com) returns that token from the page URL + public site key; Echo
 * then injects it and fires the widget callback. No proxy is used (…ProxyLess task types),
 * so only the public site key and page URL leave the machine — never the CapSolver key in an
 * error message, and never page content.
 *
 * Pure request/response shaping lives here so it can be unit-tested without a live account.
 */

const CREATE_TASK_URL = "https://api.capsolver.com/createTask";
const GET_RESULT_URL = "https://api.capsolver.com/getTaskResult";
const CREATE_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 2500;
const MAX_WALL_MS = 120_000;

/** What the page-side extractor (`CAPTCHA_SITEKEY_SCRIPT`) returns for a token challenge. */
export type CapSolverSiteInfo = {
  kind: "recaptcha" | "hcaptcha" | "turnstile" | null;
  sitekey: string | null;
  version: "v2" | "v3" | null;
  enterprise: boolean;
  invisible: boolean;
  action: string | null;
};

/** The three token families map to different response fields / injection scripts. */
export type CapSolverFamily = "recaptcha" | "hcaptcha" | "turnstile";

type CapSolverTask = Record<string, unknown> & { type: string };

type CreateTaskResponse = {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  status?: string;
  taskId?: string;
  solution?: CapSolverSolution;
};

type ResultResponse = {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  status?: string;
  solution?: CapSolverSolution;
};

type CapSolverSolution = {
  gRecaptchaResponse?: string;
  token?: string;
  text?: string;
};

export type CapSolverTokenResult = { family: CapSolverFamily; token: string };

/**
 * Choose the CapSolver task type + inputs for an extracted challenge. Pure so the mapping is
 * unit-tested. Throws for kinds CapSolver cannot take a plain site key for (e.g. no site key).
 */
export function buildCapSolverTask(info: CapSolverSiteInfo, websiteURL: string): CapSolverTask {
  if (!info.sitekey) throw new Error("No site key was found for a token solve.");
  const websiteKey = info.sitekey;
  if (info.kind === "turnstile") {
    const task: CapSolverTask = { type: "AntiTurnstileTaskProxyLess", websiteURL, websiteKey };
    if (info.action) task.metadata = { action: info.action };
    return task;
  }
  if (info.kind === "hcaptcha") {
    const task: CapSolverTask = { type: "HCaptchaTaskProxyLess", websiteURL, websiteKey };
    if (info.invisible) task.isInvisible = true;
    return task;
  }
  // reCAPTCHA (default): v3 needs a page action; v2 may be invisible.
  if (info.version === "v3") {
    const task: CapSolverTask = {
      type: info.enterprise ? "ReCaptchaV3EnterpriseTaskProxyLess" : "ReCaptchaV3TaskProxyLess",
      websiteURL,
      websiteKey,
      pageAction: info.action || "verify",
    };
    return task;
  }
  const task: CapSolverTask = {
    type: info.enterprise ? "ReCaptchaV2EnterpriseTaskProxyLess" : "ReCaptchaV2TaskProxyLess",
    websiteURL,
    websiteKey,
  };
  if (info.invisible) task.isInvisible = true;
  return task;
}

/** Which response field the token lives in, per family. */
export function readSolutionToken(solution: CapSolverSolution | undefined, family: CapSolverFamily): string {
  if (!solution) return "";
  if (family === "turnstile") return solution.token ?? "";
  return solution.gRecaptchaResponse ?? solution.token ?? "";
}

function familyOf(info: CapSolverSiteInfo): CapSolverFamily {
  if (info.kind === "turnstile") return "turnstile";
  if (info.kind === "hcaptcha") return "hcaptcha";
  return "recaptcha";
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // Never echo the request body (it carries the CapSolver key).
    throw new Error(`CapSolver returned HTTP ${res.status}.`);
  }
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** CapSolver surfaces failures in `errorDescription`; keep it, drop anything key-shaped. */
function describeError(r: { errorCode?: string; errorDescription?: string }): string {
  const detail = r.errorDescription || r.errorCode || "unknown error";
  return `CapSolver could not solve this challenge (${detail}).`;
}

/**
 * Create a CapSolver task for `info` and poll until it resolves. Returns the token + which
 * family it belongs to so the caller can pick the right injection. Throws on error/timeout
 * with a message that never contains the API key.
 */
export async function solveWithCapSolverToken(
  key: string,
  info: CapSolverSiteInfo,
  websiteURL: string,
): Promise<CapSolverTokenResult> {
  const family = familyOf(info);
  const task = buildCapSolverTask(info, websiteURL);
  const created = (await postJson(
    CREATE_TASK_URL,
    { clientKey: key, task },
    CREATE_TIMEOUT_MS,
  )) as CreateTaskResponse;
  if (created.errorId) throw new Error(describeError(created));
  if (created.status === "ready") {
    const token = readSolutionToken(created.solution, family);
    if (token) return { family, token };
  }
  const taskId = created.taskId;
  if (!taskId) throw new Error("CapSolver did not return a task id.");

  const deadline = Date.now() + MAX_WALL_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const r = (await postJson(
      GET_RESULT_URL,
      { clientKey: key, taskId },
      POLL_TIMEOUT_MS,
    )) as ResultResponse;
    if (r.errorId) throw new Error(describeError(r));
    if (r.status === "ready") {
      const token = readSolutionToken(r.solution, family);
      if (token) return { family, token };
      throw new Error("CapSolver reported success but returned no token.");
    }
    // status === "processing" (or missing) → keep polling.
  }
  throw new Error("CapSolver timed out before returning a token.");
}

/** Read a plain image CAPTCHA (base64 PNG) via CapSolver's ImageToText task. */
export async function solveImageToText(key: string, base64Png: string): Promise<string> {
  const created = (await postJson(
    CREATE_TASK_URL,
    { clientKey: key, task: { type: "ImageToTextTask", module: "common", body: base64Png } },
    CREATE_TIMEOUT_MS,
  )) as CreateTaskResponse;
  if (created.errorId) throw new Error(describeError(created));
  if (created.status === "ready") return created.solution?.text ?? "";
  const taskId = created.taskId;
  if (!taskId) throw new Error("CapSolver did not return a task id.");
  const deadline = Date.now() + MAX_WALL_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const r = (await postJson(GET_RESULT_URL, { clientKey: key, taskId }, POLL_TIMEOUT_MS)) as ResultResponse;
    if (r.errorId) throw new Error(describeError(r));
    if (r.status === "ready") return r.solution?.text ?? "";
  }
  throw new Error("CapSolver timed out before returning text.");
}
