import type { AppState } from "../shared/types";

const tabsEl = document.getElementById("tabs")!;
const urlInput = document.getElementById("url") as HTMLInputElement;
const led = document.getElementById("led")!;
const backBtn = document.getElementById("back") as HTMLButtonElement;
const forwardBtn = document.getElementById("forward") as HTMLButtonElement;
const reloadIcon = document.getElementById("reload-icon")!;
const stopIcon = document.getElementById("stop-icon")!;
const settingsEl = document.getElementById("settings")!;
const mcpUrl = document.getElementById("mcp-url")!;
const mcpLanUrl = document.getElementById("mcp-lan-url")!;
const mcpLanExtra = document.getElementById("mcp-lan-extra")!;
const mcpToken = document.getElementById("mcp-token")!;
const mcpStatus = document.getElementById("mcp-status")!;
const cursorStatus = document.getElementById("cursor-status")!;
const claudeStatus = document.getElementById("claude-status")!;
const chatgptStatus = document.getElementById("chatgpt-status")!;
const connectNote = document.getElementById("connect-note")!;
const testId = document.getElementById("test-id")!;
const testCounts = document.getElementById("test-counts")!;
const testNote = document.getElementById("test-note")!;
const newTabBtn = document.getElementById("new-tab")!;
const recordBtn = document.getElementById("record") as HTMLButtonElement;
const recordToggle = document.getElementById("record-toggle") as HTMLButtonElement;
const recordStatus = document.getElementById("record-status")!;
const recordNote = document.getElementById("record-note")!;
const recordingList = document.getElementById("recording-list")!;

let urlDirty = false;
let recListKey = "";

function render(next: AppState): void {
  led.classList.toggle("on", next.mcp.listening);
  led.title = next.mcp.listening
    ? next.connect.liveCount
      ? `MCP · ${next.connect.liveCount} connected · ${next.mcp.url}`
      : `MCP listening · no assistant · ${next.mcp.url}`
    : "MCP offline";
  backBtn.disabled = !next.canGoBack;
  forwardBtn.disabled = !next.canGoForward;
  reloadIcon.hidden = next.loading;
  stopIcon.hidden = !next.loading;
  mcpUrl.textContent = next.mcp.url;
  mcpLanUrl.textContent = next.mcp.lanUrl || "No network address found";
  mcpLanExtra.textContent =
    next.mcp.lanUrls.length > 1 ? `Also: ${next.mcp.lanUrls.slice(1).join(", ")}` : "";
  mcpStatus.textContent = next.mcp.listening
    ? next.connect.liveCount
      ? `Running on this computer · ${next.connect.liveCount} ${next.connect.liveCount === 1 ? "assistant" : "assistants"} connected now`
      : "Running on this computer · no assistant connected"
    : "Not running";
  mcpStatus.classList.toggle("live", next.mcp.listening && next.connect.liveCount > 0);
  cursorStatus.textContent = label(
    "cursor",
    next.connect.cursorLive,
    next.connect.cursorRegistered,
    next.connect.cursorConfigExists,
  );
  setLive(cursorStatus, next.connect.cursorLive);
  claudeStatus.textContent = label(
    "claude",
    next.connect.claudeLive,
    next.connect.claudeRegistered,
    next.connect.claudeConfigExists,
  );
  setLive(claudeStatus, next.connect.claudeLive);
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
  testId.textContent = next.test.id ? `Started ${next.test.startedAt}` : "No run in progress";
  testCounts.textContent = next.test.id
    ? `${next.test.assertions} checks · ${next.test.failures} failed`
    : "";
  for (const input of document.querySelectorAll("[data-transfer]")) {
    const key = (input as HTMLInputElement).dataset.transfer as keyof AppState["transfer"];
    if (key && key in next.transfer) (input as HTMLInputElement).checked = next.transfer[key];
  }
  const toolCount = document.getElementById("tool-count");
  if (toolCount) toolCount.textContent = String(next.toolCount);

  renderRecorder(next);

  const aboutVersion = document.getElementById("about-version");
  if (aboutVersion) {
    aboutVersion.textContent = `Version ${next.version} · Chromium-based · runs only on this computer`;
  }

  const active = next.tabs.find((t) => t.id === next.activeTabId);
  if (active && !urlDirty) {
    urlInput.value = displayUrl(active.url);
  }

  tabsEl.replaceChildren(
    ...next.tabs.map((tab) => {
      const btn = document.createElement("button");
      btn.className = `tab${tab.id === next.activeTabId ? " active" : ""}`;
      btn.title = tab.url;
      const title = document.createElement("span");
      title.textContent = tab.title || "New tab";
      const close = document.createElement("button");
      close.className = "x";
      close.title = "Close tab";
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void window.lb.closeTab(tab.id);
      });
      btn.append(title, close);
      btn.addEventListener("click", () => void window.lb.selectTab(tab.id));
      return btn;
    }),
    newTabBtn,
  );
}

function renderRecorder(next: AppState): void {
  const rec = next.recording;
  recordBtn.classList.toggle("on", rec.active);
  recordBtn.disabled = rec.playing;
  recordBtn.title = rec.playing ? "Playing recording" : rec.active ? "Stop recording" : "Record";
  recordBtn.setAttribute("aria-label", recordBtn.title);

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

function label(app: "cursor" | "claude" | "chatgpt", live: boolean, registered: boolean, exists: boolean): string {
  if (live) return "Connected now";
  if (registered) {
    if (app === "cursor") return "Saved in Cursor — not connected. Open Cursor and enable echo in Settings → MCP.";
    if (app === "claude") return "Saved in Claude — not connected yet. Fully quit Claude (Cmd+Q / tray Exit), keep Echo running, reopen Claude.";
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

async function openSettings(section?: string): Promise<void> {
  settingsEl.hidden = false;
  document.body.classList.add("settings-open");
  if (window.lb) await window.lb.setSettings(true);
  if (section) showSection(section);
  if (window.lb) void fillSnippets();
}

async function closeSettings(): Promise<void> {
  settingsEl.hidden = true;
  document.body.classList.remove("settings-open");
  if (window.lb) await window.lb.setSettings(false);
}

function showSection(id: string): void {
  for (const section of document.querySelectorAll(".card-list")) {
    (section as HTMLElement).hidden = section.id !== `section-${id}`;
  }
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", (item as HTMLElement).dataset.section === id);
  }
}

let snippetsToken = "";
let snippetsLocalUrl = "";
let snippetsLanUrl = "";

async function fillSnippets(): Promise<void> {
  const snippets = await window.lb.connectSnippets();
  snippetsToken = snippets.token;
  snippetsLocalUrl = snippets.localUrl;
  snippetsLanUrl = snippets.lanUrl || "";
  mcpToken.textContent = snippets.token;
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
  const el = document.getElementById(id) as HTMLTextAreaElement | null;
  if (el) el.value = value;
}

async function copyFrom(button: HTMLElement, text: string): Promise<void> {
  if (!text) return;
  await window.lb.copyText(text);
  const original = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

document.getElementById("url-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  urlDirty = false;
  void window.lb.navigate(urlInput.value);
});

urlInput.addEventListener("input", () => {
  urlDirty = true;
});

urlInput.addEventListener("blur", () => {
  urlDirty = false;
});

document.getElementById("back")!.addEventListener("click", () => void window.lb.back());
document.getElementById("forward")!.addEventListener("click", () => void window.lb.forward());
document.getElementById("reload")!.addEventListener("click", () => void window.lb.reload());
document.getElementById("new-tab")!.addEventListener("click", () => void window.lb.newTab());
document.getElementById("menu")!.addEventListener("click", () => void window.lb.openMenu());
led.addEventListener("click", () => void openSettings("connections"));
recordBtn.addEventListener("click", () => void window.lb.recordToggle());
recordToggle.addEventListener("click", async () => {
  const rec = await window.lb.getState();
  if (rec.recording.active) {
    const saved = await window.lb.recordStop();
    recordNote.textContent = saved
      ? `Saved “${saved.name}” (${saved.actions.length} steps)`
      : "No recording was in progress.";
  } else {
    await window.lb.recordStart();
    recordNote.textContent = "";
  }
});

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
  connectNote.textContent = result.message;
  render(await window.lb.getState());
});

document.getElementById("connect-claude")!.addEventListener("click", async () => {
  const result = await window.lb.connectClaude();
  connectNote.textContent = result.message;
  render(await window.lb.getState());
});

document.getElementById("connect-chatgpt")!.addEventListener("click", async () => {
  const result = await window.lb.connectChatGpt();
  connectNote.textContent = result.message;
  render(await window.lb.getState());
});

document.getElementById("copy-local-url")!.addEventListener("click", (event) => {
  void copyFrom(event.currentTarget as HTMLElement, snippetsLocalUrl || mcpUrl.textContent || "");
});
document.getElementById("copy-lan-url")!.addEventListener("click", (event) => {
  void copyFrom(event.currentTarget as HTMLElement, snippetsLanUrl);
});
document.getElementById("copy-http")!.addEventListener("click", (event) => {
  const value = (document.getElementById("snippet-http") as HTMLTextAreaElement).value;
  void copyFrom(event.currentTarget as HTMLElement, value);
});
document.getElementById("copy-http-lan")!.addEventListener("click", (event) => {
  const value = (document.getElementById("snippet-http-lan") as HTMLTextAreaElement).value;
  void copyFrom(event.currentTarget as HTMLElement, value);
});
document.getElementById("copy-stdio")!.addEventListener("click", (event) => {
  const value = (document.getElementById("snippet-stdio") as HTMLTextAreaElement).value;
  void copyFrom(event.currentTarget as HTMLElement, value);
});
document.getElementById("copy-vscode")!.addEventListener("click", (event) => {
  const value = (document.getElementById("snippet-vscode") as HTMLTextAreaElement).value;
  void copyFrom(event.currentTarget as HTMLElement, value);
});
document.getElementById("copy-token")!.addEventListener("click", (event) => {
  void copyFrom(event.currentTarget as HTMLElement, snippetsToken);
});

document.getElementById("test-start")!.addEventListener("click", async () => {
  const dir = await window.lb.testStart();
  testNote.textContent = `Saved to ${dir}`;
});

document.getElementById("test-end")!.addEventListener("click", async () => {
  const dir = await window.lb.testEnd();
  testNote.textContent = `Report saved to ${dir}`;
});

document.getElementById("open-data")!.addEventListener("click", () => void window.lb.openUserData());

const autostart = document.getElementById("autostart") as HTMLInputElement;

for (const input of document.querySelectorAll("[data-transfer]")) {
  input.addEventListener("change", () => {
    const key = (input as HTMLInputElement).dataset.transfer;
    if (!key || !window.lb) return;
    void window.lb.setTransfer({ [key]: (input as HTMLInputElement).checked });
  });
}

if (window.lb) {
  void window.lb.getAutostart().then((on) => {
    autostart.checked = on;
  });
  autostart.addEventListener("change", () => {
    void window.lb.setAutostart(autostart.checked);
  });
  window.lb.onState(render);
  window.lb.onOpenSettings((section) => void openSettings(section || "connections"));
  window.lb.onCloseSettings(() => {
    settingsEl.hidden = true;
    document.body.classList.remove("settings-open");
  });
  window.lb.onFocusOmnibox(() => {
    urlInput.focus();
    urlInput.select();
  });
  void window.lb.getState().then((state) => {
    render(state);
    void fillSnippets();
  });
} else {
  void openSettings("connections");
  for (const input of document.querySelectorAll("[data-transfer]")) {
    (input as HTMLInputElement).checked = true;
  }
}
