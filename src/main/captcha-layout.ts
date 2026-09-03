/**
 * BrowserView and window sizing for CAPTCHA widgets.
 *
 * reCAPTCHA / hCaptcha challenge iframes are often ~400×580 and sit `position:absolute`
 * next to a checkbox. Echo's page is a BrowserView under the chrome: if the view is too
 * short (overlay that slid the view down without shrinking it, leftover device emulation,
 * a window dragged under ~600px, zoom > 1), the puzzle is clipped and looks "not showing".
 * These helpers are pure so the math can be unit-tested without Electron.
 */

/** Smallest page view that still fits a typical image-grid challenge plus a little padding. */
export const CAPTCHA_MIN_VIEW = { width: 420, height: 620 };

/** Room around a measured widget so its shadow / verify button is not flush with the chrome. */
export const CAPTCHA_VIEW_PAD = 24;

export type PageViewBounds = { x: number; y: number; width: number; height: number };

/**
 * Where the page BrowserView sits inside the window's content area. The view both starts
 * below the chrome (and any overlay strip) *and* loses that much height, so the bottom of
 * the page is not clipped by the window frame.
 */
export function pageViewBounds(
  contentWidth: number,
  contentHeight: number,
  chromeHeight: number,
  overlayHeight: number,
): PageViewBounds {
  const chrome = Math.max(0, Math.round(chromeHeight));
  const overlay = Math.max(0, Math.round(overlayHeight));
  return {
    x: 0,
    y: chrome + overlay,
    width: Math.max(0, Math.round(contentWidth)),
    height: Math.max(0, Math.round(contentHeight) - chrome - overlay),
  };
}

export type CaptchaGrowInput = {
  contentWidth: number;
  contentHeight: number;
  chromeHeight: number;
  overlayHeight: number;
  widgetWidth: number;
  widgetHeight: number;
  /** When true, size for a typical image-grid popup even if only the checkbox is measured. */
  ensureMinView?: boolean;
  /** Display work area in the same DIP units as content size, minus a title-bar allowance. */
  maxContentWidth: number;
  maxContentHeight: number;
  /** Maximized / fullscreen windows keep their size — growing would fight the user. */
  locked?: boolean;
};

/**
 * Grow (never shrink) the window content size so a CAPTCHA widget can paint fully.
 * Pass `ensureMinView` when a visible puzzle is known (captcha_check / captcha_solve) so
 * there is room for the image-grid popup even if only the checkbox has been measured.
 */
export function growContentForCaptcha(input: CaptchaGrowInput): {
  width: number;
  height: number;
  grew: boolean;
} {
  const width = Math.round(input.contentWidth);
  const height = Math.round(input.contentHeight);
  if (input.locked) return { width, height, grew: false };

  const minW = input.ensureMinView ? CAPTCHA_MIN_VIEW.width : 0;
  const minH = input.ensureMinView ? CAPTCHA_MIN_VIEW.height : 0;
  const needW = Math.max(Math.round(input.widgetWidth) || 0, minW);
  const needH = Math.max(Math.round(input.widgetHeight) || 0, minH);
  const nextW = Math.min(
    Math.max(width, needW > 0 ? needW + CAPTCHA_VIEW_PAD : width),
    Math.max(width, Math.round(input.maxContentWidth)),
  );
  const nextH = Math.min(
    Math.max(
      height,
      needH > 0 ? input.chromeHeight + input.overlayHeight + needH + CAPTCHA_VIEW_PAD : height,
    ),
    Math.max(height, Math.round(input.maxContentHeight)),
  );
  const outW = Math.round(nextW);
  const outH = Math.round(nextH);
  return { width: outW, height: outH, grew: outW > width + 1 || outH > height + 1 };
}

/** Frame URLs that mean a challenge iframe just loaded and the view may need to grow. */
export function isCaptchaFrameUrl(url: string): boolean {
  return /recaptcha|hcaptcha|challenges\.cloudflare|geetest|mtcaptcha/i.test(url);
}
