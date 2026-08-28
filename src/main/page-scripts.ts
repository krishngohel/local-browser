/**
 * In-page scripts for the read/data tools, as source strings for `executeJavaScript`.
 *
 * Each builder returns a self-contained IIFE. Keep them free of page globals other than
 * `document`/`location` so they work on any site, and remember that `\s` inside these
 * template literals must be written `\\s` to survive into the emitted JavaScript.
 *
 * Pure strings, no Electron import, so this module is unit-test-bundleable.
 */

/** `innerText` of one ref, or of the body. Returns null when the ref is gone. */
export const getTextScript = (ref: string | null, maxChars: number): string => `(() => {
  const el = ${ref ? `document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)})` : "document.body"};
  if (!el) return null;
  return (el.innerText || el.textContent || '').slice(0, ${maxChars});
})()`;

/** `[{ text, href }]` for anchors, optionally filtered on text or href. */
export const linksScript = (filter: string | null, limit: number): string => `(() => {
  const filter = ${filter ? JSON.stringify(filter.toLowerCase()) : "null"};
  const out = [];
  const anchors = document.querySelectorAll('a[href]');
  for (const a of anchors) {
    const href = a.href || '';
    if (!href || href.indexOf('javascript:') === 0) continue;
    const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\\s+/g, ' ').trim();
    if (filter && text.toLowerCase().indexOf(filter) < 0 && href.toLowerCase().indexOf(filter) < 0) continue;
    out.push({ text: text.slice(0, 200), href });
    if (out.length >= ${limit}) break;
  }
  return out;
})()`;

/** Every `<table>` (first 20) as headers + rows, with the untruncated row count. */
export const tablesScript = (maxRows: number): string => `(() => {
  const max = ${maxRows};
  return Array.from(document.querySelectorAll('table')).slice(0, 20).map((t, index) => {
    const rows = Array.from(t.querySelectorAll('tr'));
    const cells = (tr) => Array.from(tr.querySelectorAll('th,td')).map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim());
    const first = rows[0] ? cells(rows[0]) : [];
    const hasHeader = Boolean(rows[0] && rows[0].querySelector('th'));
    const body = (hasHeader ? rows.slice(1) : rows).map(cells);
    return {
      index,
      caption: (t.caption && t.caption.innerText.trim()) || '',
      headers: hasHeader ? first : [],
      rows: body.slice(0, max),
      totalRows: body.length
    };
  });
})()`;

/**
 * Forms and their fields. Field `ref` comes from the `data-lb-ref` attributes a
 * `snapshot()` left behind, so the caller must snapshot first for refs to appear.
 */
export const FORMS_SCRIPT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const labelOf = (el) => clean(
    (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    ''
  ).slice(0, 120);
  return Array.from(document.querySelectorAll('form')).slice(0, 20).map((form, index) => ({
    index,
    name: form.getAttribute('name') || form.getAttribute('id') || '',
    action: form.action || location.href,
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fields: Array.from(form.querySelectorAll('input, textarea, select')).slice(0, 80).map((el) => {
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
      const field = {
        name: el.getAttribute('name') || el.getAttribute('id') || '',
        type,
        value: type === 'password' ? '' : String(el.value == null ? '' : el.value).slice(0, 200),
        label: labelOf(el)
      };
      const ref = el.getAttribute('data-lb-ref');
      if (ref) field.ref = ref;
      return field;
    })
  }));
})()`;

/** Page identity (title/url/meta/canonical/h1s) plus element counts. */
export const PAGE_INFO_SCRIPT = `(() => {
  const meta = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };
  const canonical = document.querySelector('link[rel="canonical"]');
  return {
    title: document.title || '',
    url: location.href,
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    lang: document.documentElement.getAttribute('lang') || '',
    canonical: canonical ? (canonical.href || '') : '',
    h1: Array.from(document.querySelectorAll('h1')).slice(0, 10)
      .map((h) => (h.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean),
    linkCount: document.querySelectorAll('a[href]').length,
    imageCount: document.images.length,
    formCount: document.forms.length,
    scripts: document.scripts.length
  };
})()`;

/**
 * Is the ref's element on screen? `null` means the ref itself is unknown to the page, which
 * an assertion reports differently from an element that is present but hidden.
 */
export const visibleScript = (ref: string): string => `(() => {
  const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
})()`;

/**
 * Navigation timing plus the web vitals the page preload has been accumulating.
 *
 * `__echoPerf` is a contextBridge getter, so it is a function call rather than a plain
 * object read; on a page that loaded before the preload existed it is simply absent.
 */
export const PERF_TIMING_SCRIPT = `(() => {
  const round = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null);
  const nav = performance.getEntriesByType('navigation')[0] || null;
  let vitals = null;
  try {
    vitals = window.__echoPerf && typeof window.__echoPerf.get === 'function' ? window.__echoPerf.get() : null;
  } catch (e) {
    vitals = null;
  }
  return {
    ttfb: nav ? round(nav.responseStart - nav.startTime) : null,
    domContentLoaded: nav ? round(nav.domContentLoadedEventEnd - nav.startTime) : null,
    load: nav ? round(nav.loadEventEnd - nav.startTime) : null,
    lcp: vitals ? round(vitals.lcp) : null,
    cls: vitals && typeof vitals.cls === 'number' ? Math.round(vitals.cls * 10000) / 10000 : null,
    resources: performance.getEntriesByType('resource').length,
  };
})()`;

/**
 * `outerHTML` of one ref, or of the whole document, sliced to `maxChars` in the page so a
 * large DOM never crosses IPC in full. Returns null when the ref is gone.
 */
export const htmlScript = (ref: string | null, maxChars: number): string => `(() => {
  const el = ${ref ? `document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)})` : "document.documentElement"};
  if (!el) return null;
  const html = el.outerHTML || '';
  return { html: html.slice(0, ${maxChars}), truncated: html.length > ${maxChars}, total: html.length };
})()`;

/**
 * Scans the page for a CAPTCHA or anti-bot interstitial. Detection only — Echo never solves
 * these; the result feeds the hand-off that asks the human at the machine to clear it. Looks
 * for the common widgets (reCAPTCHA, hCaptcha, Cloudflare Turnstile) and the Cloudflare
 * "checking your browser" interstitial. Returns `{ present, kind, visible }`.
 */
export const CAPTCHA_SCAN_SCRIPT = `(() => {
  const onScreen = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const checks = [
    { kind: 'recaptcha', sel: 'iframe[src*="recaptcha"], .g-recaptcha, #g-recaptcha-response' },
    { kind: 'hcaptcha', sel: 'iframe[src*="hcaptcha"], .h-captcha, [data-hcaptcha-widget-id]' },
    { kind: 'turnstile', sel: 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile' },
    { kind: 'cloudflare', sel: '#challenge-form, #cf-challenge-running, #turnstile-wrapper' },
  ];
  for (const c of checks) {
    const nodes = Array.from(document.querySelectorAll(c.sel));
    if (nodes.length) return { present: true, kind: c.kind, visible: nodes.some(onScreen) };
  }
  // Cloudflare's interstitial sometimes only shows as body text before the widget mounts.
  const title = (document.title || '').toLowerCase();
  if (title.includes('just a moment') || title.includes('attention required')) {
    return { present: true, kind: 'cloudflare', visible: true };
  }
  return { present: false, kind: null, visible: false };
})()`;

/**
 * What kind of upload target a ref is: `null` when the ref is gone, `"file-input"` for an
 * `<input type=file>`, `"other"` for anything else — which `uploadFile` then clicks while
 * intercepting the file chooser it is expected to open.
 */
export const fileInputKindScript = (ref: string): string => `(() => {
  const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
  if (!el) return null;
  return el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file'
    ? 'file-input'
    : 'other';
})()`;

/**
 * Dispatches a sequence of mouse events on one ref, centred on the element, for the
 * hover/double_click/right_click fallbacks when Playwright is not attached. Returns false
 * when the ref is gone so the caller can tell the assistant to snapshot again.
 */
export const mouseEventScript = (ref: string, events: string[]): string => `(() => {
  const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
  if (!el) return false;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: ${JSON.stringify(events.includes("contextmenu") ? 2 : 0)}
  };
  for (const type of ${JSON.stringify(events)}) el.dispatchEvent(new MouseEvent(type, init));
  return true;
})()`;

/** Same, but for recorded playback: the first selector that matches wins. */
export const mouseEventSelectorsScript = (selectors: string[], events: string[]): string => `(() => {
  for (const sel of ${JSON.stringify(selectors)}) {
    let el = null;
    try { el = document.querySelector(sel); } catch (e) { el = null; }
    if (!el) continue;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    for (const type of ${JSON.stringify(events)}) el.dispatchEvent(new MouseEvent(type, init));
    return true;
  }
  return false;
})()`;

export type KeyChord = { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };

/**
 * Splits a Playwright-style chord ("Control+Shift+P") into modifiers plus the final key.
 * Pure and exported so the keyboard_shortcut fallback can be unit tested without a page.
 */
export function parseChord(chord: string): KeyChord {
  const parts = String(chord)
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const out: KeyChord = { key: "", ctrl: false, shift: false, alt: false, meta: false };
  // A trailing "+" means the key itself is "+", e.g. "Control++".
  if (/\+\s*$/.test(chord) && parts.length) parts.push("+");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lower = part.toLowerCase();
    // Only the final segment is the key; everything before it is a modifier name.
    if (i < parts.length - 1) {
      if (lower === "control" || lower === "ctrl") { out.ctrl = true; continue; }
      if (lower === "shift") { out.shift = true; continue; }
      if (lower === "alt" || lower === "option") { out.alt = true; continue; }
      if (lower === "meta" || lower === "command" || lower === "cmd") { out.meta = true; continue; }
      if (lower === "controlormeta") { out.ctrl = true; continue; }
    }
    out.key = part;
  }
  if (!out.key) out.key = parts[parts.length - 1] ?? "";
  return out;
}

/** Fallback for `keyboard_shortcut`: keydown (then keyup) on the focused element. */
export const keyChordScript = (chord: string): string => {
  const c = parseChord(chord);
  return `(() => {
  const el = document.activeElement || document.body;
  if (!el) return false;
  const init = {
    key: ${JSON.stringify(c.key)},
    ctrlKey: ${c.ctrl},
    shiftKey: ${c.shift},
    altKey: ${c.alt},
    metaKey: ${c.meta},
    bubbles: true,
    cancelable: true
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return true;
})()`;
};
