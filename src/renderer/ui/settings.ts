import type { AppSettings, AppState } from "../../shared/types";
import type { ToolGroup, ToolManifestEntry } from "../../shared/tool-manifest";
import { GROUP_LABELS, TOOL_MANIFEST } from "../../shared/tool-manifest";
import { formatMs, h, svgIcon } from "./dom";
import { remeasureToasts, toast } from "./toasts";
import { releaseAll } from "./overlay";

/**
 * The settings page: the left nav, the sections that only read state, and the three data
 * views added in v1.1 — Tools, Activity and Appearance. Every id the pre-rewrite page used
 * is still here, because connect flows, tests and muscle memory all point at them.
 *
 * Sections redraw only while they are on screen. State is broadcast on every page event and
 * a sixty-nine-row table is real work; `showSection` redraws on the way in instead.
 */

const settingsEl = () => document.getElementById("settings")!;
const SUMMARY_MAX = 80;
let recListKey = "";
let snippetsToken = "";
let snippetsLocalUrl = "";
let snippetsLanUrl = "";
let rerender: (state: AppState) => void = () => {};
/** The last state the page saw, so a section switch can draw without waiting for the next one. */
let latest: AppState | null = null;
/** The manifest never changes while the app runs, so it is fetched once. */
let manifest: ToolManifestEntry[] | null = null;
let manifestLoading = false;
let toolsKey = "";
let activityKey = "";

/**
 * The shell's overlay teardown, injected by `main.ts`. Passing it in rather than importing it
 * keeps `settings.ts` free of a cycle back through `main.ts`. The default covers the strip
 * release on its own, so the page is still correct before `initSettings` runs.
 */
let closeOverlays: () => void = () => {
  releaseAll();
  remeasureToasts();
};

export function initSettings(
  onState: (state: AppState) => void,
  onCloseOverlays?: () => void,
): void {
  rerender = onState;
  if (onCloseOverlays) closeOverlays = onCloseOverlays;

  document.getElementById("settings-back")!.addEventListener("click", () => void closeSettings());

  for (const item of document.querySelectorAll(".nav-item")) {
    const icon = (item as HTMLElement).dataset.icon;
    if (icon) item.prepend(svgIcon(icon, "nav-icon"));
    item.addEventListener("click", () => {
      const section = (item as HTMLElement).dataset.section;
      if (section) showSection(section);
    });
  }

  const search = document.getElementById("settings-search") as HTMLInputElement | null;
  search?.addEventListener("input", () => applySearch(search.value));

  for (const btn of document.querySelectorAll("[data-open-section]")) {
    btn.addEventListener("click", () => {
      const section = (btn as HTMLElement).dataset.openSection;
      if (section) showSection(section);
    });
  }

  document.getElementById("connect-cursor")!.addEventListener("click", async () => {
    const result = await window.lb.connectCursor();
    document.getElementById("connect-note")!.textContent = result.message;
    rerender(await window.lb.getState());
  });

  document.getElementById("connect-claude")!.addEventListener("click", async () => {
    const result = await window.lb.connectClaude();
    document.getElementById("connect-note")!.textContent = result.message;
    rerender(await window.lb.getState());
  });

  document.getElementById("reveal-claude-config")!.addEventListener("click", async () => {
    const target = await window.lb.revealClaudeConfig();
    document.getElementById("connect-note")!.textContent = `Opened folder for ${target}`;
  });

  document.getElementById("connect-chatgpt")!.addEventListener("click", async () => {
    const result = await window.lb.connectChatGpt();
    document.getElementById("connect-note")!.textContent = result.message;
    rerender(await window.lb.getState());
  });

  document.getElementById("copy-local-url")!.addEventListener("click", (event) => {
    const fallback = document.getElementById("mcp-url")!.textContent || "";
    void copyFrom(event.currentTarget as HTMLElement, snippetsLocalUrl || fallback);
  });
  document.getElementById("copy-lan-url")!.addEventListener("click", (event) => {
    void copyFrom(event.currentTarget as HTMLElement, snippetsLanUrl);
  });
  document.getElementById("copy-http")!.addEventListener("click", (event) => {
    void copyFrom(event.currentTarget as HTMLElement, textareaValue("snippet-http"));
  });
  document.getElementById("copy-http-lan")!.addEventListener("click", (event) => {
    void copyFrom(event.currentTarget as HTMLElement, textareaValue("snippet-http-lan"));
  });
  document.getElementById("copy-stdio")!.addEventListener("click", (event) => {
    void copyFrom(event.currentTarget as HTMLElement, textareaValue("snippet-stdio"));
  });
  document.getElementById("copy-vscode")!.addEventListener("click", (event) => {
    void copyFrom(event.currentTarget as HTMLElement, textareaValue("snippet-vscode"));
  });
  document.getElementById("copy-token")!.addEventListener("click", (event) => {
    void copyFrom(event.currentTarget as HTMLElement, snippetsToken);
  });

  document.getElementById("test-start")!.addEventListener("click", async () => {
    const dir = await window.lb.testStart();
    document.getElementById("test-note")!.textContent = `Saved to ${dir}`;
  });

  document.getElementById("test-end")!.addEventListener("click", async () => {
    const dir = await window.lb.testEnd();
    document.getElementById("test-note")!.textContent = `Report saved to ${dir}`;
  });

  document.getElementById("open-data")!.addEventListener("click", () => void window.lb.openUserData());

  document.getElementById("record-toggle")!.addEventListener("click", async () => {
    const note = document.getElementById("record-note")!;
    const state = await window.lb.getState();
    if (state.recording.active) {
      const saved = await window.lb.recordStop();
      note.textContent = saved
        ? `Saved “${saved.name}” (${saved.actions.length} steps)`
        : "No recording was in progress.";
    } else {
      await window.lb.recordStart();
      note.textContent = "";
      toast("Recording started");
    }
  });

  for (const input of document.querySelectorAll("[data-transfer]")) {
    input.addEventListener("change", () => {
      const key = (input as HTMLInputElement).dataset.transfer;
      if (!key || !window.lb) return;
      void window.lb.setTransfer({ [key]: (input as HTMLInputElement).checked });
    });
  }

  document.getElementById("activity-clear")!.addEventListener("click", () => {
    if (!window.lb) return;
    void window.lb.clearActivity().then(() => toast("Activity cleared", "ok"));
  });

  document.getElementById("activity-pause")!.addEventListener("click", async () => {
    if (!window.lb) return;
    const paused = latest?.activity.paused === true;
    await window.lb.setPaused(!paused);
    toast(paused ? "Assistant resumed" : "Assistant paused", paused ? "ok" : "info");
  });

  const evaluateInput = document.getElementById("evaluate-enabled") as HTMLInputElement;
  evaluateInput.addEventListener("change", () => {
    if (!window.lb) return;
    void window.lb.updateSettings({ evaluateEnabled: evaluateInput.checked });
  });

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
    radio.addEventListener("change", () => {
      if (!radio.checked || !window.lb) return;
      void window.lb.updateSettings({ theme: radio.value as AppSettings["theme"] });
    });
  }

  const compact = document.getElementById("compact-chrome") as HTMLInputElement;
  compact.addEventListener("change", () => {
    if (!window.lb) return;
    void window.lb.updateSettings({ compactChrome: compact.checked });
  });

  const homeUrl = document.getElementById("home-url") as HTMLInputElement;
  document.getElementById("home-url-save")!.addEventListener("click", () => saveHomeUrl(homeUrl));
  homeUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveHomeUrl(homeUrl);
  });

  const autostart = document.getElementById("autostart") as HTMLInputElement;
  if (window.lb) {
    void window.lb.getAutostart().then((on) => {
      autostart.checked = on;
    });
    autostart.addEventListener("change", () => {
      void window.lb.setAutostart(autostart.checked);
    });
  } else {
    for (const input of document.querySelectorAll("[data-transfer]")) {
      (input as HTMLInputElement).checked = true;
    }
  }
}

/**
 * The settings page redraws only while it is on screen. State is broadcast on every page
 * event, and rewriting thirty hidden nodes (plus a JSON key over the recordings list) on each
 * one is measurable work for something nobody can see. `openSettings` redraws on the way in.
 */
export function renderSettings(next: AppState): void {
  latest = next;
  if (settingsEl().hidden) return;
  text("mcp-url", next.mcp.url);
  text("mcp-lan-url", next.mcp.lanUrl || "No network address found");
  text(
    "mcp-lan-extra",
    next.mcp.lanUrls.length > 1 ? `Also: ${next.mcp.lanUrls.slice(1).join(", ")}` : "",
  );

  const mcpStatus = document.getElementById("mcp-status")!;
  mcpStatus.textContent = next.mcp.listening
    ? next.connect.liveCount
      ? `Running on this computer · ${next.connect.liveCount} ${next.connect.liveCount === 1 ? "assistant" : "assistants"} connected now`
      : "Running on this computer · no assistant connected"
    : "Not running";
  mcpStatus.classList.toggle("live", next.mcp.listening && next.connect.liveCount > 0);

  const cursorStatus = document.getElementById("cursor-status")!;
  cursorStatus.textContent = label(
    "cursor",
    next.connect.cursorLive,
    next.connect.cursorRegistered,
    next.connect.cursorConfigExists,
  );
  setLive(cursorStatus, next.connect.cursorLive);

  const claudeStatus = document.getElementById("claude-status")!;
  claudeStatus.textContent = label(
    "claude",
    next.connect.claudeLive,
    next.connect.claudeRegistered,
    next.connect.claudeConfigExists,
  );
  setLive(claudeStatus, next.connect.claudeLive);

  const chatgptStatus = document.getElementById("chatgpt-status")!;
  chatgptStatus.textContent = label(
    "chatgpt",
    next.connect.chatgptLive,
    next.connect.chatgptRegistered,
    next.connect.chatgptConfigExists,
  );
  setLive(chatgptStatus, next.connect.chatgptLive);

  applyPlatformCopy(next.platform);

  const otherStatus = document.getElementById("other-status");
  if (otherStatus) {
    otherStatus.textContent = next.connect.otherLive
      ? `Connected now · ${next.connect.otherNames.join(", ") || "unknown client"}`
      : "No other assistant connected";
    setLive(otherStatus, next.connect.otherLive > 0);
  }

  text("test-id", next.test.id ? `Started ${next.test.startedAt}` : "No run in progress");
  text(
    "test-counts",
    next.test.id ? `${next.test.assertions} checks · ${next.test.failures} failed` : "",
  );

  for (const input of document.querySelectorAll("[data-transfer]")) {
    const key = (input as HTMLInputElement).dataset.transfer as keyof AppState["transfer"];
    if (key && key in next.transfer) (input as HTMLInputElement).checked = next.transfer[key];
  }

  text("tool-count", String(next.toolCount));
  text("about-version", `Version ${next.version} · Chromium-based · runs only on this computer`);

  const evaluateInput = document.getElementById("evaluate-enabled") as HTMLInputElement | null;
  if (evaluateInput) evaluateInput.checked = next.settings.evaluateEnabled;

  renderRecorder(next);
  renderTools(next);
  renderActivity(next);
  renderAppearance(next);
}

/* ------------------------------------------------------------------ tools */

function sectionVisible(id: string): boolean {
  const node = document.getElementById(`section-${id}`);
  return !!node && !node.hidden && !settingsEl().hidden;
}

/** `evaluate` is the one tool a group switch does not decide on its own. */
function toolIsOn(entry: ToolManifestEntry, next: AppState): boolean {
  if (entry.group === "always") return true;
  const groupOn = next.transfer[entry.group as keyof AppState["transfer"]] === true;
  if (entry.name === "evaluate") return groupOn && next.settings.evaluateEnabled;
  return groupOn;
}

function renderTools(next: AppState): void {
  const table = document.getElementById("tools-table") as HTMLTableElement | null;
  if (!table || !sectionVisible("tools")) return;
  if (!manifest) {
    void loadManifest();
    return;
  }
  const key = `${JSON.stringify(next.transfer)}:${next.settings.evaluateEnabled}`;
  if (key === toolsKey) return;
  toolsKey = key;

  const rows = manifest;
  const on = rows.filter((entry) => toolIsOn(entry, next)).length;
  text("tools-summary", `${on} of ${rows.length} tools on`);

  const head = h(
    "thead",
    {},
    h(
      "tr",
      {},
      h("th", { text: "Tool" }),
      h("th", { text: "Group" }),
      h("th", { text: "Status" }),
      h("th", { text: "Description" }),
    ),
  );
  const body = h(
    "tbody",
    {},
    ...rows.map((entry) => {
      const live = toolIsOn(entry, next);
      return h(
        "tr",
        {},
        h("td", { class: "mono", text: entry.name }),
        h("td", { class: "group", text: GROUP_LABELS[entry.group as ToolGroup] ?? entry.group }),
        h("td", {}, h("span", { class: `state${live ? " on" : ""}`, text: live ? "On" : "Off" })),
        h("td", { class: "desc", text: entry.description }),
      );
    }),
  );
  table.replaceChildren(head, body);
}

async function loadManifest(): Promise<void> {
  if (manifest || manifestLoading) return;
  manifestLoading = true;
  try {
    manifest = window.lb ? await window.lb.toolManifest().catch(() => TOOL_MANIFEST) : TOOL_MANIFEST;
  } finally {
    manifestLoading = false;
  }
  if (latest) {
    toolsKey = "";
    renderTools(latest);
  }
}

/* --------------------------------------------------------------- activity */

function activityHead(): HTMLElement {
  return h(
    "thead",
    {},
    h(
      "tr",
      {},
      h("th", { text: "Time" }),
      h("th", { text: "Client" }),
      h("th", { text: "Tool" }),
      h("th", { text: "Took" }),
      h("th", { text: "Result" }),
    ),
  );
}

function renderActivity(next: AppState): void {
  const table = document.getElementById("activity-table") as HTMLTableElement | null;
  if (!table || !sectionVisible("activity")) return;

  const count = next.activity.count;
  text("activity-count", `${count} ${count === 1 ? "call" : "calls"} this session`);
  const pause = document.getElementById("activity-pause") as HTMLButtonElement | null;
  if (pause) pause.textContent = next.activity.paused ? "Resume" : "Pause";

  const key = `${next.activity.paused}:${next.activity.recent.map((e) => e.id).join(",")}`;
  if (key === activityKey) return;
  activityKey = key;

  const head = activityHead();

  if (!next.activity.recent.length) {
    table.replaceChildren(
      head,
      h(
        "tbody",
        {},
        h(
          "tr",
          {},
          h("td", {
            class: "empty",
            colspan: "5",
            text: next.connect.liveCount
              ? "No calls yet. Ask your assistant to open a page."
              : "No assistant connected. Open Connections to connect one.",
          }),
        ),
      ),
    );
    return;
  }

  const body = h(
    "tbody",
    {},
    ...next.activity.recent.map((entry) => {
      const summary = entry.summary || (entry.ok ? "Done" : "Failed");
      const short = summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary;
      const result = h("td", { class: "desc", title: summary });
      result.append(
        h("span", { class: `mark ${entry.ok ? "ok" : "bad"}`, text: entry.ok ? "\u2713" : "\u2717" }),
        " ",
        short,
      );
      return h(
        "tr",
        {},
        h("td", { class: "mono", text: clockTime(entry.startedAt) }),
        h("td", { class: "dim", text: entry.client || "unknown" }),
        h("td", { class: "mono", text: entry.tool }),
        h("td", { class: "num dim", text: formatMs(entry.ms) }),
        result,
      );
    }),
  );
  table.replaceChildren(head, body);
}

/** Local HH:MM:SS. The stamp is an ISO string, which nobody reads at a glance. */
function clockTime(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "--:--:--";
  return when.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/* ------------------------------------------------------------- appearance */

function renderAppearance(next: AppState): void {
  if (!sectionVisible("appearance")) return;
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
    radio.checked = radio.value === next.settings.theme;
  }
  const compact = document.getElementById("compact-chrome") as HTMLInputElement | null;
  if (compact) compact.checked = next.settings.compactChrome;
  const homeUrl = document.getElementById("home-url") as HTMLInputElement | null;
  // Never overwrite a URL half-typed.
  if (homeUrl && document.activeElement !== homeUrl) homeUrl.value = next.settings.homeUrl;
}

function saveHomeUrl(input: HTMLInputElement): void {
  const value = input.value.trim();
  if (!/^https?:\/\//i.test(value)) {
    toast("Enter a full URL starting with http:// or https://", "error");
    return;
  }
  if (!window.lb) return;
  void window.lb.updateSettings({ homeUrl: value }).then(() => toast("Home page saved", "ok"));
}

/* ----------------------------------------------------------------- search */

/**
 * Filters the nav and the cards at once. A section stays in the nav when its own name matches
 * *or* it holds a matching card, so searching "token" keeps Connections reachable rather than
 * hiding the only place the match lives.
 */
function applySearch(raw: string): void {
  const query = raw.trim().toLowerCase();
  let firstVisible = "";
  let anyVisible = false;

  for (const item of document.querySelectorAll<HTMLElement>(".nav-item")) {
    const id = item.dataset.section ?? "";
    const section = document.getElementById(`section-${id}`);
    const navText = (item.textContent ?? "").toLowerCase();
    const sectionText = (section?.textContent ?? "").toLowerCase();
    const hit = !query || navText.includes(query) || sectionText.includes(query);
    item.classList.toggle("filtered", !hit);
    if (hit) {
      anyVisible = true;
      if (!firstVisible) firstVisible = id;
    }
    if (!section) continue;
    for (const card of section.querySelectorAll<HTMLElement>(".card")) {
      const cardHit = !query || (card.textContent ?? "").toLowerCase().includes(query);
      card.classList.toggle("filtered", !cardHit);
    }
    for (const panel of section.querySelectorAll<HTMLElement>(".panel")) {
      const cards = [...panel.querySelectorAll<HTMLElement>(".card")];
      const empty = cards.length > 0 && cards.every((card) => card.classList.contains("filtered"));
      panel.classList.toggle("filtered", empty);
    }
  }

  const emptyNote = document.getElementById("settings-search-empty");
  if (emptyNote) emptyNote.hidden = anyVisible;

  // Landing on a section with nothing left to show reads as a broken search.
  if (query && firstVisible) {
    const active = document.querySelector<HTMLElement>(".nav-item.active");
    if (!active || active.classList.contains("filtered")) showSection(firstVisible);
  }
}

function clearSearch(): void {
  const search = document.getElementById("settings-search") as HTMLInputElement | null;
  if (search) search.value = "";
  for (const node of document.querySelectorAll(".filtered")) node.classList.remove("filtered");
  const emptyNote = document.getElementById("settings-search-empty");
  if (emptyNote) emptyNote.hidden = true;
}

function renderRecorder(next: AppState): void {
  const rec = next.recording;
  const recordStatus = document.getElementById("record-status")!;
  const recordToggle = document.getElementById("record-toggle") as HTMLButtonElement;
  const recordNote = document.getElementById("record-note")!;
  const recordingList = document.getElementById("recording-list")!;

  if (rec.playing) {
    recordStatus.textContent = "Playing…";
    recordToggle.textContent = "Playing…";
    recordToggle.disabled = true;
  } else if (rec.active) {
    recordStatus.textContent = `Recording “${rec.name}” · ${rec.actionCount} ${rec.actionCount === 1 ? "step" : "steps"}`;
    recordToggle.textContent = "Stop recording";
    recordToggle.disabled = false;
  } else {
    recordStatus.textContent = "Not recording";
    recordToggle.textContent = "Start recording";
    recordToggle.disabled = false;
  }

  if (document.activeElement?.classList.contains("rec-name")) return;
  const key = `${rec.active}:${rec.playing}:${JSON.stringify(rec.recordings)}`;
  if (key === recListKey) return;
  recListKey = key;

  recordingList.replaceChildren(
    ...rec.recordings.map((item) => {
      const card = document.createElement("div");
      card.className = "card";
      const info = document.createElement("div");
      const name = document.createElement("input");
      name.className = "rec-name";
      name.value = item.name;
      name.title = "Rename";
      name.addEventListener("change", () => {
        void window.lb.recordingRename(item.id, name.value);
      });
      const meta = document.createElement("p");
      meta.className = "meta";
      const when = new Date(item.createdAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      meta.textContent = `${item.actionCount} ${item.actionCount === 1 ? "step" : "steps"} · ${when}`;
      info.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "rec-actions";
      const play = document.createElement("button");
      play.className = "chrome-btn filled";
      play.textContent = "Play";
      play.disabled = rec.active || rec.playing;
      play.addEventListener("click", async () => {
        recordNote.textContent = "Playing…";
        const result = await window.lb.recordingPlay(item.id);
        recordNote.textContent = result.message;
      });
      const del = document.createElement("button");
      del.className = "chrome-btn";
      del.textContent = "Delete";
      del.disabled = rec.playing;
      del.addEventListener("click", () => {
        void window.lb.recordingDelete(item.id);
      });
      actions.append(play, del);
      card.append(info, actions);
      return card;
    }),
  );
}

function label(
  app: "cursor" | "claude" | "chatgpt",
  live: boolean,
  registered: boolean,
  exists: boolean,
): string {
  if (live) return "Connected now";
  if (registered) {
    if (app === "cursor") return "Saved in Cursor — not connected. Open Cursor and enable echo in Settings → MCP.";
    if (app === "claude") return "Saved in Claude — not connected yet. Open Claude → Settings → Developer → Edit Config, confirm echo exists, fully quit Claude (Cmd+Q / tray Exit), keep Echo running, reopen Claude.";
    return "Saved in Codex — not connected. Fully quit and reopen ChatGPT desktop or Codex.";
  }
  if (exists) return "Found a config file — click Connect to add Echo";
  return "Not connected";
}

function setLive(el: HTMLElement, live: boolean): void {
  el.classList.toggle("live", live);
}

function applyPlatformCopy(platform: string): void {
  const firewall = document.getElementById("os-firewall");
  if (firewall) {
    if (platform === "darwin") {
      firewall.textContent =
        "If another device on Wi-Fi cannot connect, allow incoming connections for Echo in System Settings → Network → Firewall.";
    } else if (platform === "linux") {
      firewall.textContent =
        "If another device on Wi-Fi cannot connect, allow TCP 18931 (or Echo) through your firewall.";
    } else {
      firewall.textContent =
        "If a phone or laptop on Wi-Fi cannot connect, allow Echo through Windows Firewall on private networks.";
    }
  }
  const meta = document.getElementById("autostart-meta");
  if (meta) {
    meta.textContent =
      platform === "darwin"
        ? "Start Echo in the menu bar so the browser is ready before Cursor."
        : "Start Echo in the tray so the browser is ready before Cursor.";
  }
}

export async function openSettings(section?: string): Promise<void> {
  clearSearch();
  settingsEl().hidden = false;
  setOpenClass(true);
  if (window.lb) await window.lb.setSettings(true);
  if (section) showSection(section);
  if (window.lb) void fillSnippets();
}

export async function closeSettings(): Promise<void> {
  settingsEl().hidden = true;
  setOpenClass(false);
  dropOverlays();
  if (window.lb) await window.lb.setSettings(false);
}

/** Local close for the main-process "close-settings" push, which already updated the hub. */
export function hideSettings(): void {
  settingsEl().hidden = true;
  setOpenClass(false);
  dropOverlays();
}

/**
 * Panels claim a strip of the page view. Nothing claims while settings is open, but a claim
 * made before it opened would otherwise be handed to the page on the way out.
 *
 * This runs the shell's full overlay teardown, not just the strip release: main swallows
 * Escape while settings is open and pushes `close-settings` instead, so the palette's own
 * Escape handler never fires and it would survive the page it was opened over.
 */
function dropOverlays(): void {
  closeOverlays();
}

/** Both nodes carry the class: <html> sizes the document, <body> drives the layout rules. */
function setOpenClass(open: boolean): void {
  document.documentElement.classList.toggle("settings-open", open);
  document.body.classList.toggle("settings-open", open);
}

export function showSection(id: string): void {
  // A name nothing wired up falls back to Connections rather than leaving an empty pane.
  const target = document.getElementById(`section-${id}`) ? id : "connections";
  for (const section of document.querySelectorAll(".card-list")) {
    (section as HTMLElement).hidden = section.id !== `section-${target}`;
  }
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", (item as HTMLElement).dataset.section === target);
  }
  const content = document.querySelector(".settings-content");
  if (content) content.scrollTop = 0;
  // The three data sections skip their draw while hidden, so they redraw on the way in.
  if (latest) {
    renderTools(latest);
    renderActivity(latest);
    renderAppearance(latest);
  }
}

export async function fillSnippets(): Promise<void> {
  const snippets = await window.lb.connectSnippets();
  snippetsToken = snippets.token;
  snippetsLocalUrl = snippets.localUrl;
  snippetsLanUrl = snippets.lanUrl || "";
  text("mcp-token", snippets.token);
  setTextarea("snippet-http", snippets.httpJson);
  setTextarea("snippet-http-lan", snippets.httpLanJson || "No network address found on this computer.");
  setTextarea("snippet-stdio", snippets.stdioJson);
  setTextarea("snippet-vscode", snippets.vscodeJson);
  const copyLan = document.getElementById("copy-lan-url") as HTMLButtonElement;
  const copyHttpLan = document.getElementById("copy-http-lan") as HTMLButtonElement;
  copyLan.disabled = !snippets.lanUrl;
  copyHttpLan.disabled = !snippets.httpLanJson;
}

function setTextarea(id: string, value: string): void {
  const node = document.getElementById(id) as HTMLTextAreaElement | null;
  if (node) node.value = value;
}

function textareaValue(id: string): string {
  return (document.getElementById(id) as HTMLTextAreaElement | null)?.value ?? "";
}

function text(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

async function copyFrom(button: HTMLElement, value: string): Promise<void> {
  if (!value) return;
  await window.lb.copyText(value);
  const original = button.textContent;
  button.textContent = "Copied";
  toast("Copied", "ok");
  window.setTimeout(() => {
    button.textContent = original;
  }, 1400);
}
