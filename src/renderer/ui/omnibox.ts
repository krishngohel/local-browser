import type { AppState } from "../../shared/types";
import { h, hostOf, svgIcon } from "./dom";
import { place, release } from "./overlay";
import { hidePreview } from "./tabs";

const DEBOUNCE_MS = 120;
const HISTORY_MAX = 6;
const TAB_MAX = 3;

type Suggestion = {
  kind: "tab" | "history" | "search";
  title: string;
  sub: string;
  /** What Enter sends to `lb.navigate` — main normalizes URLs and falls back to search. */
  value: string;
  tabId?: string;
};

let input!: HTMLInputElement;
let form!: HTMLFormElement;
let panel!: HTMLElement;
let icon!: HTMLElement;
let last: AppState | null = null;
let items: Suggestion[] = [];
let cursor = -1;
let debounce = 0;
/** True while the user is typing, so incoming state updates must not overwrite the field. */
let dirty = false;

export function initOmnibox(
  urlInput: HTMLInputElement,
  urlForm: HTMLFormElement,
  suggestionsRoot: HTMLElement,
  securityIcon: HTMLElement,
): void {
  input = urlInput;
  form = urlForm;
  panel = suggestionsRoot;
  icon = securityIcon;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const chosen = cursor >= 0 ? items[cursor] : null;
    close();
    dirty = false;
    if (chosen?.kind === "tab" && chosen.tabId) {
      void window.lb.selectTab(chosen.tabId);
      return;
    }
    void window.lb.navigate(chosen ? chosen.value : input.value);
    input.blur();
  });

  input.addEventListener("input", () => {
    dirty = true;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void build(), DEBOUNCE_MS);
  });

  input.addEventListener("focus", () => {
    input.select();
  });

  input.addEventListener("blur", () => {
    // A click on a suggestion fires blur first; the row's mousedown handler already ran.
    window.setTimeout(() => {
      if (document.activeElement !== input) {
        dirty = false;
        close();
        if (last) setUrlFromState(last);
      }
    }, 120);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Escape") {
      if (!panel.hidden) {
        event.preventDefault();
        close();
      } else {
        dirty = false;
        if (last) setUrlFromState(last);
        input.blur();
      }
    }
  });
}

/** Refreshes the address field (unless the user is typing) and the security indicator. */
export function renderOmnibox(state: AppState): void {
  last = state;
  if (!dirty) setUrlFromState(state);
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  const url = active?.url ?? "";
  icon.replaceChildren();
  let name: "lock" | "warning" | "search" = "search";
  let label = "Search or type a URL";
  if (/^https:/i.test(url)) {
    name = "lock";
    label = "Connection is encrypted";
  } else if (/^http:/i.test(url)) {
    name = "warning";
    label = "Not secure";
  }
  icon.className = `omni-icon ${name}`;
  icon.title = label;
  icon.setAttribute("aria-label", label);
  icon.append(svgIcon(name));
}

export function focusOmnibox(): void {
  input.focus();
  input.select();
}

export function closeSuggestions(): void {
  close();
}

function setUrlFromState(state: AppState): void {
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  if (active) input.value = displayUrl(active.url);
}

/** A Google results page reads better as the query the user typed. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "www.google.com" && parsed.pathname === "/search") {
      return parsed.searchParams.get("q") || url;
    }
  } catch {
    /* keep raw */
  }
  return url;
}

async function build(): Promise<void> {
  const query = input.value.trim();
  if (!query) return close();

  const needle = query.toLowerCase();
  const next: Suggestion[] = [];

  for (const tab of last?.tabs ?? []) {
    if (tab.id === last?.activeTabId) continue;
    if (!`${tab.title} ${tab.url}`.toLowerCase().includes(needle)) continue;
    next.push({
      kind: "tab",
      title: tab.title || "New tab",
      sub: hostOf(tab.url),
      value: tab.url,
      tabId: tab.id,
    });
    if (next.length >= TAB_MAX) break;
  }

  const history = await window.lb.searchHistory(query).catch(() => []);
  const seen = new Set(next.map((s) => s.value));
  for (const entry of history) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    next.push({ kind: "history", title: entry.title || entry.url, sub: entry.url, value: entry.url });
    if (next.filter((s) => s.kind === "history").length >= HISTORY_MAX) break;
  }

  next.push({
    kind: "search",
    title: `Search Google for ${query}`,
    sub: "",
    value: query,
  });

  // The query moved on while history was being read.
  if (input.value.trim() !== query) return;
  items = next;
  cursor = -1;
  draw();
}

function draw(): void {
  if (!items.length) return close();
  panel.replaceChildren(
    ...items.map((item, index) => {
      const row = h("div", {
        class: `sug${index === cursor ? " on" : ""}`,
        role: "option",
        id: `sug-${index}`,
        "aria-selected": index === cursor ? "true" : "false",
      });
      row.append(svgIcon(item.kind === "search" ? "search" : item.kind === "tab" ? "monitor" : "history", "sug-icon"));
      row.append(
        h(
          "span",
          { class: "sug-text" },
          h("span", { class: "sug-title", text: item.title }),
          item.sub ? h("span", { class: "sug-sub", text: item.sub }) : null,
        ),
      );
      if (item.kind === "tab") row.append(h("span", { class: "sug-tag", text: "Open tab" }));
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        cursor = index;
        form.requestSubmit();
      });
      row.addEventListener("mousemove", () => {
        if (cursor === index) return;
        cursor = index;
        highlight();
      });
      return row;
    }),
  );
  panel.setAttribute("role", "listbox");
  input.setAttribute("aria-expanded", "true");
  hidePreview();
  const box = input.closest(".omnibox")!.getBoundingClientRect();
  // Matched to the omnibox, but capped: a full-width list on a wide window is mostly padding.
  place("omnibox", panel, box, { width: Math.min(720, Math.max(320, box.width)) });
}

function highlight(): void {
  for (const [index, row] of [...panel.children].entries()) {
    row.classList.toggle("on", index === cursor);
    row.setAttribute("aria-selected", index === cursor ? "true" : "false");
  }
  input.setAttribute("aria-activedescendant", cursor >= 0 ? `sug-${cursor}` : "");
}

function move(delta: number): void {
  if (panel.hidden || !items.length) return;
  cursor += delta;
  if (cursor < -1) cursor = items.length - 1;
  if (cursor >= items.length) cursor = -1;
  highlight();
}

function close(): void {
  window.clearTimeout(debounce);
  items = [];
  cursor = -1;
  panel.hidden = true;
  panel.replaceChildren();
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  release("omnibox");
}
