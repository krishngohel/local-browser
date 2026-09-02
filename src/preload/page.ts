import { contextBridge, ipcRenderer } from "electron";

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
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
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
