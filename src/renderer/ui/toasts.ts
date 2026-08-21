import { h, maybe, svgIcon } from "./dom";
import { reserve } from "./overlay";

const MAX = 3;
const LIFE_MS = 3500;

type Kind = "info" | "ok" | "error";

let timer = 0;

/** Short confirmation in the top-right of the chrome. Announced politely, never focus-stealing. */
export function toast(message: string, kind: Kind = "info"): void {
  const root = maybe<HTMLElement>("toasts");
  if (!root) return;
  const item = h("div", { class: `toast ${kind}` });
  if (kind !== "info") item.append(svgIcon(kind === "ok" ? "check" : "warning", "toast-icon"));
  item.append(h("span", { text: message }));
  root.append(item);
  while (root.children.length > MAX) root.firstElementChild?.remove();
  measure();
  window.setTimeout(() => {
    item.remove();
    measure();
  }, LIFE_MS);
}

function measure(): void {
  const root = maybe<HTMLElement>("toasts");
  if (!root) return;
  window.clearTimeout(timer);
  if (!root.children.length) {
    reserve("toasts", 0);
    return;
  }
  // One frame later the new node has a height.
  timer = window.setTimeout(() => {
    reserve("toasts", root.getBoundingClientRect().bottom);
  }, 0);
}
