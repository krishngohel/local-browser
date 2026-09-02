import { h, svgIcon } from "./dom";
import { release, reserve } from "./overlay";

/**
 * Command palette (Ctrl+K / Ctrl+Shift+P).
 *
 * Actions are supplied lazily by `main.ts` so every label reflects the current state — the
 * recorder entry reads "Stop recording" while a take is running, and one row exists per open
 * tab. Nothing is cached between opens.
 *
 * Like every other renderer panel it has to claim a strip of the window: the page is a
 * BrowserView layered above this document, so `reserve` slides the page down far enough for
 * the panel to be visible. The claim is re-made after each redraw because the list shrinks as
 * the query narrows.
 */

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
};

/**
 * Twelve rows fit in the list box (see `.palette-list` in styles.css); anything past that
 * scrolls rather than being dropped, so a long tab list is still reachable with the arrows.
 */

let panel: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLElement | null = null;
let root: HTMLElement | null = null;
let supply: () => PaletteAction[] = () => [];
let shown: PaletteAction[] = [];
let cursor = 0;
let restoreTo: HTMLElement | null = null;

export function initPalette(rootEl: HTMLElement, actions: () => PaletteAction[]): void {
  root = rootEl;
  supply = actions;

  input = h("input", {
    class: "palette-input",
    id: "palette-input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "Type a command",
    role: "combobox",
    "aria-label": "Type a command",
    "aria-autocomplete": "list",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
  }) as HTMLInputElement;

  list = h("div", {
    class: "palette-list",
    id: "palette-list",
    role: "listbox",
    "aria-label": "Commands",
  });

  panel = h(
    "div",
    { class: "palette-panel", role: "dialog", "aria-modal": "true", "aria-label": "Command palette" },
    h("div", { class: "palette-head" }, svgIcon("command", "palette-glyph"), input),
    list,
  );

  rootEl.replaceChildren(panel);
  rootEl.hidden = true;

  input.addEventListener("input", () => draw());
  input.addEventListener("keydown", onKeydown);

  // mousedown, not click: the input loses focus on press, and a click that lands on the
  // backdrop after the list redrew would otherwise be read as an outside click.
  rootEl.addEventListener("mousedown", (event) => {
    if (!panel!.contains(event.target as Node)) closePalette();
  });
}

export function isPaletteOpen(): boolean {
  return root !== null && !root.hidden;
}

export function openPalette(): void {
  if (!root || !input) return;
  if (isPaletteOpen()) {
    input.select();
    return;
  }
  const active = document.activeElement;
  restoreTo = active instanceof HTMLElement && active !== document.body ? active : null;
  root.hidden = false;
  input.value = "";
  cursor = 0;
  draw();
  input.focus();
}

export function closePalette(): void {
  if (!root || root.hidden) return;
  root.hidden = true;
  list?.replaceChildren();
  shown = [];
  release("palette");
  const back = restoreTo;
  restoreTo = null;
  if (back?.isConnected) back.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    runAt(cursor);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
  }
}

function move(delta: number): void {
  if (!shown.length) return;
  cursor = (cursor + delta + shown.length) % shown.length;
  highlight();
}

function runAt(index: number): void {
  const action = shown[index];
  if (!action) return;
  closePalette();
  void action.run();
}

/**
 * Fuzzy match: every character of the query appears in `label` in order, case-insensitive.
 * The score is the span the match covers, so "ntab" prefers "New tab" over a label where the
 * same letters are scattered across a sentence. An empty query keeps the declared order.
 */
function score(label: string, query: string): number | null {
  const hay = label.toLowerCase();
  let from = 0;
  let start = -1;
  for (const ch of query) {
    const at = hay.indexOf(ch, from);
    if (at < 0) return null;
    if (start < 0) start = at;
    from = at + 1;
  }
  return start < 0 ? 0 : (from - start) * 1000 + start;
}

function draw(): void {
  if (!root || !input || !list || !panel) return;
  const query = input.value.trim().toLowerCase();
  const all = supply();

  if (query) {
    const ranked: { action: PaletteAction; rank: number; order: number }[] = [];
    all.forEach((action, order) => {
      const rank = score(action.label, query);
      if (rank !== null) ranked.push({ action, rank, order });
    });
    ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
    shown = ranked.map((item) => item.action);
  } else {
    shown = all;
  }

  if (cursor >= shown.length) cursor = 0;

  if (!shown.length) {
    list.replaceChildren(h("p", { class: "palette-empty", text: "No matching command" }));
  } else {
    list.replaceChildren(
      ...shown.map((action, index) => {
        const row = h("div", {
          class: `palette-row${index === cursor ? " on" : ""}`,
          role: "option",
          id: `palette-row-${index}`,
          "aria-selected": index === cursor ? "true" : "false",
        });
        row.append(h("span", { class: "palette-label", text: action.label }));
        if (action.hint) row.append(h("span", { class: "palette-hint", text: action.hint }));
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
          runAt(index);
        });
        row.addEventListener("mousemove", () => {
          if (cursor === index) return;
          cursor = index;
          highlight();
        });
        return row;
      }),
    );
  }
  highlight();
  reserve("palette", panel.getBoundingClientRect().bottom);
}

function highlight(): void {
  if (!list || !input) return;
  if (!shown.length) {
    input.removeAttribute("aria-activedescendant");
    return;
  }
  for (const [index, row] of [...list.children].entries()) {
    row.classList.toggle("on", index === cursor);
    row.setAttribute("aria-selected", index === cursor ? "true" : "false");
  }
  const current = list.children[cursor] as HTMLElement | undefined;
  current?.scrollIntoView({ block: "nearest" });
  input.setAttribute("aria-activedescendant", `palette-row-${cursor}`);
}
