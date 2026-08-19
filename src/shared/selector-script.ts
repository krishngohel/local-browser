/** Injected into pages to build replay-stable CSS selectors (not ephemeral data-lb-ref). */
export const ECHO_SELECTORS_SOURCE = `function echoSelectors(el) {
  if (!el || el.nodeType !== 1) return [];
  const out = [];
  const tag = el.tagName.toLowerCase();
  if (el.id) out.push('#' + CSS.escape(el.id));
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
  if (testId) out.push('[data-testid="' + cssAttr(testId) + '"]');
  const name = el.getAttribute('name');
  if (name) out.push(tag + '[name="' + cssAttr(name) + '"]');
  const aria = el.getAttribute('aria-label');
  if (aria) out.push(tag + '[aria-label="' + cssAttr(aria) + '"]');
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) out.push(tag + '[placeholder="' + cssAttr(placeholder) + '"]');
  const href = el.getAttribute('href');
  if (href && href.length < 180 && href.indexOf('javascript:') !== 0) {
    out.push('a[href="' + cssAttr(href) + '"]');
  }
  out.push(cssPath(el));
  return out.filter(Boolean);
}
function cssAttr(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}
function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 7) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift('#' + CSS.escape(node.id));
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}`;
