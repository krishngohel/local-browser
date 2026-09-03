/**
 * Space reservation for renderer overlays.
 *
 * The page is an Electron BrowserView layered *above* this document, so anything the chrome
 * draws below its own height — omnibox suggestions, the assistant popover, tab previews,
 * toasts — would be hidden behind the page. The fix is to reserve a strip: main slides the
 * page view down *and shrinks its height* by the requested number of pixels (`lb.setOverlay`),
 * uncovering that much of this document without clipping the bottom of the page (CAPTCHA
 * challenge iframes are often position:fixed near the checkbox).
 *
 * Several overlays can be open at once (a toast during a suggestion list), so the reserve is
 * the max of every claim rather than a sum.
 */

const claims = new Map<string, number>();
let applied = -1;

/** Bottom padding under the tallest panel so its shadow is not cut off. */
const GUTTER = 10;

/** Default when the shell cannot be measured (it is `display:none` on the settings page). */
const FALLBACK_CHROME_H = 84;

export function chromeHeight(): number {
  const shell = document.querySelector(".shell") as HTMLElement | null;
  const measured = shell ? Math.round(shell.getBoundingClientRect().height) : 0;
  return measured > 0 ? measured : FALLBACK_CHROME_H;
}

function settingsOpen(): boolean {
  return document.body.classList.contains("settings-open");
}

/** Reserves down to `bottomPx` in viewport coordinates. Pass 0 to release the claim. */
export function reserve(name: string, bottomPx: number): void {
  // The settings page is full-window: there is no page view to uncover, and the hidden shell
  // would measure 0 and turn every panel into a full-height claim that lands on the page the
  // moment settings closes.
  if (settingsOpen()) {
    release(name);
    return;
  }
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
