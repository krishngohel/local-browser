/**
 * Space reservation for renderer overlays.
 *
 * The page is an Electron BrowserView layered *above* this document, so anything the chrome
 * draws below its own height — omnibox suggestions, the assistant popover, tab previews,
 * toasts — would be hidden behind the page. The fix is to reserve a strip: main slides the
 * page view down by the requested number of pixels (`lb.setOverlay`), uncovering that much
 * of this document. The view keeps its size, so no site reflows while a dropdown is open.
 *
 * Several overlays can be open at once (a toast during a suggestion list), so the reserve is
 * the max of every claim rather than a sum.
 */

const claims = new Map<string, number>();
let applied = -1;

/** Bottom padding under the tallest panel so its shadow is not cut off. */
const GUTTER = 10;

export function chromeHeight(): number {
  const shell = document.querySelector(".shell") as HTMLElement | null;
  return shell ? Math.round(shell.getBoundingClientRect().height) : 84;
}

/** Reserves down to `bottomPx` in viewport coordinates. Pass 0 to release the claim. */
export function reserve(name: string, bottomPx: number): void {
  const need = bottomPx <= 0 ? 0 : Math.max(0, Math.round(bottomPx + GUTTER - chromeHeight()));
  if (need <= 0) claims.delete(name);
  else claims.set(name, need);
  apply();
}

export function release(name: string): void {
  if (claims.delete(name)) apply();
}

export function releaseAll(): void {
  if (!claims.size) return;
  claims.clear();
  apply();
}

function apply(): void {
  let height = 0;
  for (const value of claims.values()) height = Math.max(height, value);
  if (height === applied) return;
  applied = height;
  document.documentElement.style.setProperty("--overlay-h", `${height}px`);
  void window.lb?.setOverlay?.(height);
}

/**
 * Places a floating panel under an anchor and reserves room for it. Panels are positioned in
 * viewport coordinates against `body`, not against their trigger, because the trigger sits
 * inside a `overflow:hidden` toolbar.
 */
export function place(
  name: string,
  panel: HTMLElement,
  anchor: DOMRect,
  opts: { align?: "left" | "right"; width?: number; gap?: number } = {},
): void {
  const gap = opts.gap ?? 6;
  panel.hidden = false;
  if (opts.width) panel.style.width = `${Math.round(opts.width)}px`;
  panel.style.top = `${Math.round(anchor.bottom + gap)}px`;
  // Measure after the width is set: the panel wraps its own content otherwise.
  const width = panel.getBoundingClientRect().width;
  const max = document.documentElement.clientWidth;
  let left = opts.align === "right" ? anchor.right - width : anchor.left;
  left = Math.max(8, Math.min(left, max - width - 8));
  panel.style.left = `${Math.round(left)}px`;
  reserve(name, panel.getBoundingClientRect().bottom);
}
