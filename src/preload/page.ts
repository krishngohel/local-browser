import { contextBridge, ipcRenderer } from "electron";
import { firefoxUserAgent } from "../main/user-agent";

// --- Present as a normal browser, at document-start --------------------------------------
//
// Google's "browser or app may not be secure" interstitial is a server-side WebView check:
// an embedded Chromium that claims to be Google Chrome is rejected. HTTP (applyChromeSession)
// already sends a Firefox UA to accounts.google.com; this keeps JS on that page in agreement
// and, on every other page, still scrubs Electron tells (webdriver, UA-CH brands, outer==inner).
function installEchoStealth(firefoxUa: string): void {
  type Brand = { brand?: string; version?: string };
  const nav = navigator as unknown as Record<string, unknown> & { userAgent: string };
  const win = window as unknown as Record<string, unknown>;
  const host = String(location.hostname || "").toLowerCase();
  const path = String(location.pathname || "").toLowerCase();
  const googleAuth =
    host === "accounts.google.com" ||
    host.endsWith(".accounts.google.com") ||
    host === "accounts.youtube.com" ||
    host === "gsi.google.com" ||
    host === "oauth2.googleapis.com" ||
    ((host === "google.com" || host === "www.google.com") && /\/(signin|accounts|oauth)/.test(path));

  const define = (obj: object, key: string, getter: () => unknown): void => {
    try {
      Object.defineProperty(obj, key, { get: getter, configurable: true });
    } catch {
      /* locked by the engine */
    }
  };

  try {
    define(Navigator.prototype, "webdriver", () => undefined);
    define(nav, "webdriver", () => undefined);
  } catch {
    /* AutomationControlled already zeroes the native getter */
  }

  // BrowserView fills its box: outerWidth === innerWidth is a classic "this is a WebView" tell.
  try {
    const chromeH = 88;
    define(win, "outerHeight", () => Math.round(Number(win.innerHeight) + chromeH));
    define(win, "outerWidth", () => Math.round(Number(win.innerWidth)));
  } catch {
    /* cosmetic */
  }

  if (googleAuth) {
    define(nav, "userAgent", () => firefoxUa);
    define(nav, "appVersion", () => firefoxUa.replace(/^Mozilla\//, ""));
    define(nav, "vendor", () => "");
    define(nav, "appName", () => "Netscape");
    define(nav, "product", () => "Gecko");
    define(nav, "productSub", () => "20100101");
    define(nav, "userAgentData", () => undefined);
    define(win, "chrome", () => undefined);
    try {
      (win as { __echoStealth?: boolean }).__echoStealth = true;
    } catch {
      /* */
    }
    return;
  }

  const scrub = (list: Brand[] | undefined): Brand[] | undefined => {
    if (!Array.isArray(list)) return list;
    const out = list.filter((b) => b && typeof b.brand === "string" && !/electron|echo/i.test(b.brand));
    const chromium = out.find((b) => /chromium/i.test(b.brand || ""));
    if (chromium && !out.some((b) => b.brand === "Google Chrome")) {
      out.unshift({ brand: "Google Chrome", version: chromium.version });
    }
    return out;
  };
  try {
    const ua = nav.userAgent || "";
    if (/electron|(?:^| )echo\//i.test(ua)) {
      const clean = ua.replace(/\s(?:Echo|Electron)\/[^\s]+/gi, "");
      define(nav, "userAgent", () => clean);
      define(nav, "appVersion", () => clean.replace(/^Mozilla\//, ""));
    }
  } catch {
    /* keep the session-provided UA */
  }
  try {
    const uad = nav.userAgentData as
      | { brands?: Brand[]; getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>> }
      | undefined;
    if (uad) {
      const brands = scrub(uad.brands);
      define(uad, "brands", () => brands);
      if (typeof uad.getHighEntropyValues === "function") {
        const orig = uad.getHighEntropyValues.bind(uad);
        Object.defineProperty(uad, "getHighEntropyValues", {
          configurable: true,
          writable: true,
          value: (hints: string[]) =>
            orig(hints).then((v) => {
              if (v && Array.isArray(v.brands)) v.brands = scrub(v.brands as Brand[]);
              if (v && Array.isArray(v.fullVersionList)) v.fullVersionList = scrub(v.fullVersionList as Brand[]);
              return v;
            }),
        });
      }
    }
  } catch {
    /* userAgentData missing (non-secure context) — nothing to scrub */
  }
  try {
    const chrome = (win.chrome as Record<string, unknown>) || {};
    if (!chrome.runtime) chrome.runtime = {};
    if (!chrome.app) chrome.app = { isInstalled: false };
    if (typeof chrome.csi !== "function") chrome.csi = () => ({});
    if (typeof chrome.loadTimes !== "function") chrome.loadTimes = () => ({});
    win.chrome = chrome;
  } catch {
    /* window.chrome is best-effort cosmetic */
  }
  try {
    (win as { __echoStealth?: boolean }).__echoStealth = true;
  } catch {
    /* */
  }
}

try {
  contextBridge.executeInMainWorld({
    func: installEchoStealth,
    args: [firefoxUserAgent(process.platform)],
  });
} catch {
  /* older Electron without executeInMainWorld — the wire-level UA/client hints still apply */
}

const INTERACTIVE =
  'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [contenteditable="true"]';

type PendingType = { selectors: string[]; text: string };

let pendingType: PendingType | null = null;
let typeTimer: ReturnType<typeof setTimeout> | null = null;

function cssAttr(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 7) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift("#" + CSS.escape(node.id));
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const tagName = node.tagName;
      const same = Array.from(parent.children).filter((c) => (c as Element).tagName === tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

function echoSelectors(el: Element): string[] {
  const out: string[] = [];
  const tag = el.tagName.toLowerCase();
  if (el.id) out.push("#" + CSS.escape(el.id));
  const testId = el.getAttribute("data-testid") || el.getAttribute("data-test");
  if (testId) out.push(`[data-testid="${cssAttr(testId)}"]`);
  const name = el.getAttribute("name");
  if (name) out.push(`${tag}[name="${cssAttr(name)}"]`);
  const aria = el.getAttribute("aria-label");
  if (aria) out.push(`${tag}[aria-label="${cssAttr(aria)}"]`);
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) out.push(`${tag}[placeholder="${cssAttr(placeholder)}"]`);
  const href = el.getAttribute("href");
  if (href && href.length < 180 && !href.startsWith("javascript:")) {
    out.push(`a[href="${cssAttr(href)}"]`);
  }
  out.push(cssPath(el));
  return out.filter(Boolean);
}

function closestInteractive(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest(INTERACTIVE) ?? target;
}

function send(payload: Record<string, unknown>): void {
  ipcRenderer.send("echo:page-event", payload);
}

function flushType(submit = false): void {
  if (typeTimer) {
    clearTimeout(typeTimer);
    typeTimer = null;
  }
  if (!pendingType) return;
  send({ type: "type", selectors: pendingType.selectors, text: pendingType.text, submit });
  pendingType = null;
}

window.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    const el = closestInteractive(event.target);
    if (!el) return;
    const tag = el.tagName;
    if (tag === "HTML" || tag === "BODY") return;
    flushType(false);
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 80);
    send({ type: "click", selectors: echoSelectors(el), text });
  },
  true,
);

window.addEventListener(
  "input",
  (event) => {
    if (!event.isTrusted) return;
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable))) {
      return;
    }
    const text = el instanceof HTMLElement && el.isContentEditable ? el.innerText : (el as HTMLInputElement).value;
    pendingType = { selectors: echoSelectors(el), text };
    if (typeTimer) clearTimeout(typeTimer);
    typeTimer = setTimeout(() => flushType(false), 700);
  },
  true,
);

window.addEventListener(
  "keydown",
  (event) => {
    if (!event.isTrusted) return;
    if (event.key === "Enter" && pendingType) {
      flushType(true);
    }
  },
  true,
);

window.addEventListener(
  "change",
  (event) => {
    if (!event.isTrusted) return;
    const el = event.target;
    if (el instanceof HTMLSelectElement) {
      flushType(false);
      send({ type: "select", selectors: echoSelectors(el), value: el.value });
    }
  },
  true,
);

window.addEventListener("blur", () => flushType(false), true);

// --- CAPTCHA widget fit ----------------------------------------------------------------
//
// Challenge iframes (reCAPTCHA bframe, hCaptcha, GeeTest) inject themselves and then
// resize — 3×3 vs 4×4 grids, audio vs images. The BrowserView does not auto-grow, so the
// page preload watches those nodes and tells main the box so the window can be unclipped
// and, if needed, enlarged.

const CAPTCHA_FIT_SEL =
  'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="mtcaptcha"], iframe[src*="geetest"], .geetest_window, .geetest_panel, .geetest_panel_box';

function installCaptchaFitWatch(): void {
  const watching = new WeakSet<Element>();
  let lastKey = "";
  let lastAt = 0;
  const notify = (el: Element): void => {
    const r = el.getBoundingClientRect();
    const width = Math.ceil(r.width);
    const height = Math.ceil(r.height);
    if (width < 60 && height < 60) return;
    const key = `${width}x${height}`;
    const now = Date.now();
    if (key === lastKey && now - lastAt < 200) return;
    lastKey = key;
    lastAt = now;
    ipcRenderer.send("echo:captcha-fit", { width, height });
  };
  const scan = (): void => {
    for (const el of document.querySelectorAll(CAPTCHA_FIT_SEL)) {
      if (watching.has(el)) continue;
      watching.add(el);
      notify(el);
      try {
        new ResizeObserver(() => notify(el)).observe(el);
      } catch {
        /* ResizeObserver missing — MutationObserver still picks up new iframes */
      }
    }
  };
  const start = (): void => {
    scan();
    try {
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

installCaptchaFitWatch();

// --- Web vitals -------------------------------------------------------------------------
//
// LCP and CLS can only be read by an observer that was watching from the start of the page,
// so they are collected here rather than by a script the hub injects later. The values live
// in the isolated world; the page (and so `perf_timing`, which evaluates in the main world)
// reaches them through one exposed getter. An object of live numbers cannot cross the bridge
// — only the function can — hence `__echoPerf.get()` rather than `__echoPerf.lcp`.

let lcp: number | null = null;
let cls: number | null = null;

function observe(type: string, onEntry: (entry: PerformanceEntry) => void): void {
  try {
    // `buffered` replays entries that fired before this observer existed.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) onEntry(entry);
    }).observe({ type, buffered: true } as PerformanceObserverInit);
  } catch {
    /* the browser may not support this entry type; the value simply stays null */
  }
}

observe("largest-contentful-paint", (entry) => {
  // Every LCP entry supersedes the last, so the newest one wins.
  lcp = Math.round(entry.startTime * 100) / 100;
});

observe("layout-shift", (entry) => {
  const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
  // Shifts within 500ms of a user interaction are expected, and Core Web Vitals excludes them.
  if (shift.hadRecentInput) return;
  cls = Math.round(((cls ?? 0) + (shift.value ?? 0)) * 10000) / 10000;
});

try {
  contextBridge.exposeInMainWorld("__echoPerf", {
    get: () => ({ lcp, cls }),
  });
} catch {
  /* already exposed, or context isolation is off; perf_timing falls back to nulls */
}

// --- JavaScript dialogs -----------------------------------------------------------------
//
// alert/confirm/prompt are answered here, in the page, rather than through Playwright.
// Electron cancels every JS dialog raised inside a BrowserView within a few milliseconds and
// does not implement `window.prompt` at all, so a CDP round trip can never win the race.
// Overriding the three functions in the main world makes the tab's `dialog` policy the thing
// that decides, and lets the main process record what the page asked.
//
// `sendSync` is deliberate: alert/confirm/prompt are synchronous by contract, so the answer
// has to be in hand before the call returns.

type DialogAnswer = { accept: boolean; promptText: string | null };

function answerDialog(type: string, message: string): DialogAnswer {
  try {
    const reply = ipcRenderer.sendSync("echo:dialog", {
      type,
      message: String(message ?? "").slice(0, 500),
    }) as DialogAnswer | undefined;
    if (reply && typeof reply === "object" && typeof reply.accept === "boolean") return reply;
  } catch {
    /* the main process is gone or has no handler; fall through to the safe answer */
  }
  return { accept: false, promptText: null };
}

/**
 * Installs the three overrides in the main world, where the page's own scripts see them.
 *
 * `executeInMainWorld` serialises this function and hands `answerDialog` across as a proxy,
 * so the callback lives only in the closure below — unlike `exposeInMainWorld`, it leaves
 * nothing on `window` for the page to find or call. The function is re-compiled in the main
 * world, so it must reference nothing outside its own arguments.
 */
function installDialogShim(answer: (type: string, message: string) => DialogAnswer): void {
  const ask = (type: string, message: unknown): DialogAnswer => {
    try {
      return answer(type, message == null ? "" : String(message));
    } catch {
      return { accept: false, promptText: null };
    }
  };
  window.alert = function alert(message?: unknown): void {
    ask("alert", message);
  };
  window.confirm = function confirm(message?: unknown): boolean {
    return ask("confirm", message).accept === true;
  };
  window.prompt = function prompt(message?: unknown, defaultValue?: unknown): string | null {
    const answered = ask("prompt", message);
    if (!answered.accept) return null;
    if (answered.promptText != null) return String(answered.promptText);
    return defaultValue == null ? "" : String(defaultValue);
  };
}

try {
  contextBridge.executeInMainWorld({ func: installDialogShim, args: [answerDialog] });
} catch {
  /* without the shim the page keeps Electron's own behaviour: every dialog is cancelled */
}
