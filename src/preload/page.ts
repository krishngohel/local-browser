import { ipcRenderer } from "electron";

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
