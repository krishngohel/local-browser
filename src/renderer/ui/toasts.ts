import { h, maybe, svgIcon } from "./dom";
import { reserve } from "./overlay";

const MAX = 3;
const LIFE_MS = 3500;

type Kind = "info" | "ok" | "error";
type ToastAction = { label: string; onClick: () => void };

let timer = 0;

/**
 * Short confirmation in the top-right of the chrome. Announced politely, never focus-stealing.
 * With an `action`, the toast skips its normal auto-dismiss and stays until that action is
 * clicked — used for update-ready notices the user should be able to act on whenever they
 * notice it, not just within the next 3.5 seconds.
 */
export function toast(message: string, kind: Kind = "info", action?: ToastAction): void {
  const root = maybe<HTMLElement>("toasts");
  if (!root) return;
  const item = h("div", { class: `toast ${kind}` });
  if (kind !== "info") item.append(svgIcon(kind === "ok" ? "check" : "warning", "toast-icon"));
  item.append(h("span", { text: message }));
  if (action) {
    const btn = h("button", { class: "toast-action", text: action.label });
    btn.addEventListener("click", () => {
      action.onClick();
      item.remove();
      remeasureToasts();
    });
    item.append(btn);
    // Action-toasts skip the auto-dismiss timer below, so without this the toast (and the
    // overlay strip it reserves) would stay put for the rest of the session unless the user
    // clicks the action itself. This is the escape hatch that doesn't require restarting the app.
    const dismiss = h("button", {
      class: "toast-dismiss",
      "aria-label": "Dismiss",
      text: "×",
    });
    dismiss.addEventListener("click", () => {
      item.remove();
      remeasureToasts();
    });
    item.append(dismiss);
  }
  root.append(item);
  while (root.children.length > MAX) root.firstElementChild?.remove();
  remeasureToasts();
  if (!action) {
    window.setTimeout(() => {
      item.remove();
      remeasureToasts();
    }, LIFE_MS);
  }
}

/**
 * Re-claims the strip a visible toast needs. `releaseAll` drops every claim at once (Escape,
 * a resize, leaving settings), and a toast outlives all three, so its owner has to ask again.
 */
export function remeasureToasts(): void {
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
