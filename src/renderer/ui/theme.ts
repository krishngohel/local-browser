import type { AppSettings } from "../../shared/types";

/**
 * Theme and chrome density.
 *
 * `light` / `dark` pin `data-theme` on <html>; `system` removes it so the
 * `prefers-color-scheme` block in styles.css decides. Compact mode changes the shell's
 * height, so main is told the new number straight after the class flips.
 */
export function applyTheme(settings: AppSettings): void {
  const root = document.documentElement;
  if (settings.theme === "light" || settings.theme === "dark") root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  // Both nodes carry the class: <html> so `--chrome-h` resolves for the document height,
  // <body> for every layout rule below it.
  const compact = settings.compactChrome === true;
  root.classList.toggle("compact", compact);
  document.body.classList.toggle("compact", compact);
  reportChromeHeight();
}

/** Measures the real shell height and hands it to main so the page sits flush under it. */
export function reportChromeHeight(): void {
  const shell = document.querySelector(".shell") as HTMLElement | null;
  if (!shell) return;
  const height = Math.round(shell.getBoundingClientRect().height);
  if (height > 0) void window.lb?.setChromeHeight(height);
}

let chromeObserved = false;

/** Watch the shell so compact mode, DPI, and font changes keep the BrowserView flush. */
export function watchChromeHeight(): void {
  if (chromeObserved) return;
  const shell = document.querySelector(".shell") as HTMLElement | null;
  if (!shell || typeof ResizeObserver === "undefined") return;
  chromeObserved = true;
  const ro = new ResizeObserver(() => reportChromeHeight());
  ro.observe(shell);
  window.addEventListener("resize", () => reportChromeHeight());
  const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) void fonts.ready.then(() => reportChromeHeight());
  requestAnimationFrame(() => reportChromeHeight());
}
