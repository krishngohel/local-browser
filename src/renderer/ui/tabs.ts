import type { AppState, TabInfo } from "../../shared/types";
import { h, hostOf, maybe, svgIcon } from "./dom";
import { chromeHeight, place, release, reserve } from "./overlay";

const HOVER_MS = 500;

let hoverTimer = 0;
let previewFor: string | null = null;
let dragId: string | null = null;
/** Suppresses re-renders mid-drag so the row does not shuffle under the pointer. */
let dragging = false;
/** Signature of the strip as last drawn. */
let lastKey = "";

/**
 * Draws the tab strip. Tabs are pills: favicon (globe when the site has none), title, close.
 * Middle-click closes, drag reorders, and a half-second hover opens a preview card.
 */
export function renderTabs(state: AppState, root: HTMLElement): void {
  if (dragging) return;
  // State is broadcast on every page event; rebuilding the strip when nothing in it moved is
  // wasted layout, and it also drops the pointer out of whatever tab is being hovered.
  const key = tabsKey(state);
  if (key === lastKey && root.childElementCount === state.tabs.length) return;
  lastKey = key;
  // The pill the card was anchored to is about to be replaced; if its tab is gone entirely the
  // card would hang there pointing at nothing.
  if (previewFor && !state.tabs.some((t) => t.id === previewFor)) hidePreview();
  root.replaceChildren(...state.tabs.map((tab, index) => tabPill(tab, index, state)));
}

function tabsKey(state: AppState): string {
  return state.tabs
    .map((t) =>
      [t.id, t.title, t.url, t.loading ? 1 : 0, t.incognito ? 1 : 0, (t.favicon ?? "").slice(-24)].join(
        "\u0001",
      ),
    )
    .concat(state.activeTabId ?? "")
    .join("\u0002");
}

function tabPill(tab: TabInfo, index: number, state: AppState): HTMLElement {
  const active = tab.id === state.activeTabId;
  const pill = h("div", {
    class: `tab${active ? " active" : ""}${tab.loading ? " loading" : ""}${tab.incognito ? " private" : ""}`,
    role: "tab",
    tabindex: "0",
    draggable: "true",
    "aria-selected": active ? "true" : "false",
    title: tab.title || tab.url,
    "data-tab": tab.id,
  });

  pill.append(favicon(tab));
  pill.append(h("span", { class: "tab-title", text: tab.title || "New tab" }));

  const close = h("button", {
    class: "tab-close",
    type: "button",
    title: "Close tab",
    "aria-label": `Close ${tab.title || "tab"}`,
  });
  close.append(svgIcon("close"));
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    hidePreview();
    void window.lb.closeTab(tab.id);
  });
  pill.append(close);

  if (tab.loading) pill.append(h("i", { class: "tab-bar" }));

  pill.addEventListener("click", () => {
    hidePreview();
    void window.lb.selectTab(tab.id);
  });
  pill.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void window.lb.selectTab(tab.id);
    }
  });
  pill.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    hidePreview();
    void window.lb.closeTab(tab.id);
  });
  // Chromium scrolls on middle-press unless the default is stopped here too.
  pill.addEventListener("mousedown", (event) => {
    if (event.button === 1) event.preventDefault();
  });

  pill.addEventListener("mouseenter", () => {
    window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => void showPreview(tab, pill), HOVER_MS);
  });
  pill.addEventListener("mouseleave", () => {
    window.clearTimeout(hoverTimer);
    if (previewFor === tab.id) hidePreview();
  });

  pill.addEventListener("dragstart", (event) => {
    dragId = tab.id;
    dragging = true;
    hidePreview();
    pill.classList.add("drag");
    event.dataTransfer?.setData("text/plain", tab.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  pill.addEventListener("dragend", () => {
    dragging = false;
    dragId = null;
    lastKey = "";
    pill.classList.remove("drag");
    for (const node of document.querySelectorAll(".tab.drop-before, .tab.drop-after")) {
      node.classList.remove("drop-before", "drop-after");
    }
  });
  pill.addEventListener("dragover", (event) => {
    if (!dragId || dragId === tab.id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = pill.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    pill.classList.toggle("drop-before", !after);
    pill.classList.toggle("drop-after", after);
  });
  pill.addEventListener("dragleave", () => pill.classList.remove("drop-before", "drop-after"));
  pill.addEventListener("drop", (event) => {
    event.preventDefault();
    const moved = dragId;
    pill.classList.remove("drop-before", "drop-after");
    dragging = false;
    dragId = null;
    lastKey = "";
    if (!moved || moved === tab.id) return;
    const rect = pill.getBoundingClientRect();
    const from = state.tabs.findIndex((t) => t.id === moved);
    let to = event.clientX > rect.left + rect.width / 2 ? index + 1 : index;
    // Removing the dragged tab first shifts every later slot one to the left.
    if (from >= 0 && from < to) to -= 1;
    void window.lb.reorderTab(moved, to);
  });

  return pill;
}

function favicon(tab: TabInfo): HTMLElement {
  const wrap = h("span", { class: "tab-fav" });
  if (tab.incognito) {
    wrap.append(svgIcon("incognito", "fav-glyph"));
    return wrap;
  }
  if (tab.favicon) {
    // Main resolves remote icons to data URLs; the CSP forbids loading them from the network.
    const img = h("img", { src: tab.favicon, alt: "", width: "16", height: "16" });
    img.addEventListener("error", () => {
      img.replaceWith(svgIcon("globe", "fav-glyph"));
    });
    wrap.append(img);
    return wrap;
  }
  wrap.append(svgIcon("globe", "fav-glyph"));
  return wrap;
}

async function showPreview(tab: TabInfo, pill: HTMLElement): Promise<void> {
  const card = maybe<HTMLElement>("tab-preview");
  if (!card) return;
  previewFor = tab.id;
  const shot = await window.lb.tabThumbnail(tab.id).catch(() => "");
  // The pointer may have left while the capture was in flight.
  if (previewFor !== tab.id || !pill.isConnected) return;
  card.replaceChildren();
  if (shot) {
    const img = h("img", { class: "preview-shot", src: shot, alt: "" });
    // The image has no height until it decodes, so the first measurement is short by the whole
    // thumbnail. Claim the rest of the strip once the real height exists.
    img.addEventListener("load", () => {
      if (!card.hidden) reserve("tab-preview", card.getBoundingClientRect().bottom);
    });
    card.append(img);
  } else {
    // Background tabs that have not been on screen since their last navigation have no
    // capture to serve; the placeholder says so instead of showing a blank frame.
    const empty = h("div", { class: "preview-empty" });
    empty.append(svgIcon(tab.incognito ? "incognito" : "globe", "preview-glyph"));
    card.append(empty);
  }
  card.append(
    h(
      "div",
      { class: "preview-meta" },
      h("span", { class: "preview-title", text: tab.title || "New tab" }),
      h("span", { class: "preview-host", text: hostOf(tab.url) || "No page loaded" }),
    ),
  );
  // Anchored to the bottom of the chrome, not the tab: a card that started at the tab would
  // sit on top of the toolbar.
  const rect = pill.getBoundingClientRect();
  place(
    "tab-preview",
    card,
    new DOMRect(rect.left, 0, rect.width, chromeHeight()),
    { width: 260, gap: 6 },
  );
}

/** Forces the next render to rebuild, after a drag or a theme change. */
export function invalidateTabs(): void {
  lastKey = "";
}

export function hidePreview(): void {
  window.clearTimeout(hoverTimer);
  previewFor = null;
  const card = maybe<HTMLElement>("tab-preview");
  if (card) card.hidden = true;
  release("tab-preview");
}
