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
 * `outerHTML` of one ref, or of the whole document, sliced to `maxChars` in the page so a
 * large DOM never crosses IPC in full. Returns null when the ref is gone.
 */
export const htmlScript = (ref: string | null, maxChars: number): string => `(() => {
  const el = ${ref ? `document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)})` : "document.documentElement"};
  if (!el) return null;
  const html = el.outerHTML || '';
  return { html: html.slice(0, ${maxChars}), truncated: html.length > ${maxChars}, total: html.length };
})()`;
