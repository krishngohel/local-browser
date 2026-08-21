import type { ActivityEntry, AppState } from "../../shared/types";
import { formatMs, h, svgIcon } from "./dom";
import { place, release } from "./overlay";
import { toast } from "./toasts";

/**
 * The assistant pill: one control that answers "is anything connected, is it doing something
 * right now, and what has it done". It replaces the old MCP LED.
 *
 * The pill doubles as a trace. While a tool call runs, a thin indigo line sweeps along its
 * bottom edge; the popover renders each past call's duration as a proportional bar, so the
 * rhythm of the assistant's work is readable at a glance instead of parsed from numbers.
 */

let pill!: HTMLButtonElement;
let pop!: HTMLElement;
let openSettings: (section: string) => void = () => {};
let last: AppState | null = null;
let open = false;

export function initAssistant(
  pillEl: HTMLButtonElement,
  popEl: HTMLElement,
  onOpenSettings: (section: string) => void,
): void {
  pill = pillEl;
  pop = popEl;
  openSettings = onOpenSettings;

  pill.addEventListener("click", () => {
    open = !open;
    if (open) drawPopover();
    else closePopover();
  });

  document.addEventListener("mousedown", (event) => {
    if (!open) return;
    const target = event.target as Node;
    if (pill.contains(target) || pop.contains(target)) return;
    closePopover();
  });
}

export function closePopover(): void {
  open = false;
  pop.hidden = true;
  pop.replaceChildren();
  pill.setAttribute("aria-expanded", "false");
  release("assistant");
}

export function renderAssistant(state: AppState): void {
  last = state;
  const { tone, text } = status(state);
  const running = state.activity.running;

  pill.className = `pill assistant ${tone}${running ? " running" : ""}`;
  pill.setAttribute("aria-expanded", open ? "true" : "false");
  pill.title = running ? `Running ${running}` : `${text} · ${state.mcp.url}`;
  pill.replaceChildren();
  pill.append(h("i", { class: "dot" }));

  if (running) {
    pill.append(svgIcon("spinner", "pill-spinner"));
    pill.append(h("span", { class: "pill-text", text: running }));
  } else {
    pill.append(h("span", { class: "pill-text", text }));
  }

  if (state.activity.count > 0) {
    pill.append(h("span", { class: "pill-badge", text: String(state.activity.count) }));
  }
  // Signature element: the live trace line under the pill.
  pill.append(h("i", { class: "trace" }));

  if (open) drawPopover();
}

function status(state: AppState): { tone: string; text: string } {
  if (state.activity.paused) return { tone: "paused", text: "Paused" };
  if (!state.mcp.listening) return { tone: "off", text: "MCP off" };
  const c = state.connect;
  const names: string[] = [];
  if (c.cursorLive) names.push("Cursor");
  if (c.claudeLive) names.push("Claude");
  if (c.chatgptLive) names.push("ChatGPT");
  const total = names.length + c.otherLive;
  if (total === 0) return { tone: "listening", text: "No assistant" };
  if (total === 1) return { tone: "live", text: names[0] ?? c.otherNames[0] ?? "Assistant" };
  return { tone: "live", text: `${total} assistants` };
}

function drawPopover(): void {
  const state = last;
  if (!state) return;
  open = true;
  const recent = state.activity.recent;
  const longest = Math.max(1, ...recent.map((e) => e.ms));

  const head = h(
    "div",
    { class: "pop-head" },
    h("span", { class: "pop-title", text: "Assistant activity" }),
    h("span", {
      class: "pop-count",
      text: state.activity.count === 1 ? "1 call" : `${state.activity.count} calls`,
    }),
  );

  const list = h("div", { class: "pop-list" });
  if (!recent.length) {
    list.append(
      h("p", {
        class: "pop-empty",
        text: state.connect.liveCount
          ? "No calls yet. Ask your assistant to open a page."
          : "No assistant connected. Open Settings → Connections to connect one.",
      }),
    );
  } else {
    for (const entry of recent) list.append(row(entry, longest));
  }

  const pauseBtn = h("button", {
    class: `pop-btn${state.activity.paused ? " warn" : ""}`,
    type: "button",
  });
  pauseBtn.append(svgIcon(state.activity.paused ? "play" : "pause"));
  pauseBtn.append(
    h("span", { text: state.activity.paused ? "Resume assistant" : "Pause assistant" }),
  );
  pauseBtn.addEventListener("click", () => {
    const next = !state.activity.paused;
    void window.lb.setPaused(next);
    toast(next ? "Assistant paused" : "Assistant resumed", next ? "info" : "ok");
  });

  const activityBtn = h("button", { class: "pop-btn ghost", type: "button", text: "Open Activity" });
  activityBtn.addEventListener("click", () => {
    closePopover();
    openSettings("activity");
  });

  pop.replaceChildren(head, list, h("div", { class: "pop-foot" }, pauseBtn, activityBtn));
  place("assistant", pop, pill.getBoundingClientRect(), { align: "right", width: 340 });
  pill.setAttribute("aria-expanded", "true");
}

function row(entry: ActivityEntry, longest: number): HTMLElement {
  const width = Math.max(2, Math.round((entry.ms / longest) * 100));
  const bar = h("i", { class: "call-bar" });
  bar.style.width = `${width}%`;
  const status = svgIcon(entry.ok ? "check" : "close", "call-status");
  status.setAttribute("aria-label", entry.ok ? "Succeeded" : "Failed");
  status.removeAttribute("aria-hidden");
  status.setAttribute("role", "img");
  return h(
    "div",
    { class: `call${entry.ok ? "" : " bad"}`, title: entry.summary || entry.tool },
    h(
      "div",
      { class: "call-top" },
      status,
      h("span", { class: "call-tool", text: entry.tool }),
      h("span", { class: "call-client", text: entry.client || "unknown" }),
      h("span", { class: "call-ms", text: formatMs(entry.ms) }),
    ),
    h("div", { class: "call-track" }, bar),
  );
}
