import type { AppState } from "../../shared/types";
import { toast } from "./toasts";

/**
 * The settings page. Behaviour is carried over unchanged from the pre-rewrite renderer —
 * same ids, same copy, same handlers — so nothing an existing user relies on moved. Task 12
 * redesigns the markup; this module only relocates the logic out of `main.ts`.
 */

const settingsEl = () => document.getElementById("settings")!;
let recListKey = "";
let snippetsToken = "";
let snippetsLocalUrl = "";
let snippetsLanUrl = "";
let rerender: (state: AppState) => void = () => {};

export function initSettings(onState: (state: AppState) => void): void {
  rerender = onState;

  document.getElementById("settings-back")!.addEventListener("click", () => void closeSettings());

  for (const item of document.querySelectorAll(".nav-item")) {
    item.addEventListener("click", () => {
      const section = (item as HTMLElement).dataset.section;
      if (section) showSection(section);
    });
  }

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

  renderRecorder(next);
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
  settingsEl().hidden = false;
  setOpenClass(true);
  if (window.lb) await window.lb.setSettings(true);
  if (section) showSection(section);
  if (window.lb) void fillSnippets();
}

export async function closeSettings(): Promise<void> {
  settingsEl().hidden = true;
  setOpenClass(false);
  if (window.lb) await window.lb.setSettings(false);
}

/** Local close for the main-process "close-settings" push, which already updated the hub. */
export function hideSettings(): void {
  settingsEl().hidden = true;
  setOpenClass(false);
}

/** Both nodes carry the class: <html> sizes the document, <body> drives the layout rules. */
function setOpenClass(open: boolean): void {
  document.documentElement.classList.toggle("settings-open", open);
  document.body.classList.toggle("settings-open", open);
}

export function showSection(id: string): void {
  // Sections that do not exist yet (Activity lands in the next task) fall back to Connections
  // rather than leaving an empty pane.
  const target = document.getElementById(`section-${id}`) ? id : "connections";
  for (const section of document.querySelectorAll(".card-list")) {
    (section as HTMLElement).hidden = section.id !== `section-${target}`;
  }
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", (item as HTMLElement).dataset.section === target);
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
