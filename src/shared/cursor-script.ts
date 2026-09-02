/** Injected before an assistant click/type/select/hover to show a small cursor moving to the target — purely cosmetic, never affects the real action that follows. Idempotent: safe to call repeatedly on the same page. */
export function moveCursorScript(x: number, y: number): string {
  return `(() => {
    let el = document.getElementById('__echo_cursor__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__echo_cursor__';
      el.style.cssText = 'position:fixed;z-index:2147483647;width:14px;height:14px;margin:-2px 0 0 -2px;border-radius:50%;background:rgba(255,80,80,0.85);box-shadow:0 0 0 2px rgba(255,255,255,0.9);pointer-events:none;transition:left 120ms ease,top 120ms ease,opacity 120ms ease;opacity:0;';
      document.documentElement.appendChild(el);
    }
    el.style.left = ${JSON.stringify(String(x))} + 'px';
    el.style.top = ${JSON.stringify(String(y))} + 'px';
    el.style.opacity = '1';
  })()`;
}

/** Bounding-box center of a snapshot ref, in viewport coordinates, or null if the ref isn't found. */
export function elementCenterScript(ref: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}
