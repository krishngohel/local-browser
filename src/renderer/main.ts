import type { AppSettings, AppState } from "../shared/types";
import { el, svgIcon } from "./ui/dom";
import { applyTheme, reportChromeHeight, watchChromeHeight } from "./ui/theme";
import { renderTabs, hidePreview, invalidateTabs } from "./ui/tabs";
import { initGrid, syncGrid } from "./ui/grid";
import { initOmnibox, renderOmnibox, focusOmnibox, closeSuggestions } from "./ui/omnibox";
import { initAssistant, renderAssistant, closePopover } from "./ui/assistant";
import { remeasureToasts, toast } from "./ui/toasts";
import { releaseAll } from "./ui/overlay";
import { closePalette, initPalette, openPalette, type PaletteAction } from "./ui/palette";
import {
  fillSnippets,
  hideSettings,
  initSettings,
  openSettings,
  renderSettings,
  showSection,
} from "./ui/settings";

const tabsEl = el("tabs");
const urlInput = el<HTMLInputElement>("url");
const urlForm = el<HTMLFormElement>("url-form");
const suggest = el("omni-suggest");
const security = el("omni-security");
const backBtn = el<HTMLButtonElement>("back");
const forwardBtn = el<HTMLButtonElement>("forward");
const reloadBtn = el<HTMLButtonElement>("reload");
const reloadIcon = el("reload-icon");
const stopIcon = el("stop-icon");
const newTabBtn = el<HTMLButtonElement>("new-tab");
const recordBtn = el<HTMLButtonElement>("record");
const bookmarkBtn = el<HTMLButtonElement>("bookmark");
const menuBtn = el<HTMLButtonElement>("menu");
const assistantPill = el<HTMLButtonElement>("assistant-pill");
const assistantPop = el("assistant-pop");
const paletteRoot = el("palette");

let state: AppState | null = null;
let themeKey = "";
let updateToastKey = "";

function render(next: AppState): void {
  state = next;

  const key = `${next.settings.theme}:${next.settings.compactChrome}`;
  if (key !== themeKey) {
    themeKey = key;
    applyTheme(next.settings);
    invalidateTabs();
  }

  backBtn.disabled = !next.canGoBack;
  forwardBtn.disabled = !next.canGoForward;
  reloadIcon.hidden = next.loading;
  stopIcon.hidden = !next.loading;
  reloadBtn.title = next.loading ? "Stop" : "Reload";
  reloadBtn.setAttribute("aria-label", reloadBtn.title);

  renderTabs(next, tabsEl);
  syncGrid(next.tabs.filter((t) => t.osr).map((t) => t.id));
  renderOmnibox(next);
  renderAssistant(next);
  renderBookmark(next);
  renderRecordButton(next);
  renderSettings(next);
  renderUpdateToast(next);
}

let bookmarkOn: boolean | null = null;

function renderBookmark(next: AppState): void {
  const on = next.bookmarks.activeBookmarked;
  if (on === bookmarkOn) return;
  bookmarkOn = on;
  bookmarkBtn.classList.toggle("on", on);
  bookmarkBtn.title = on ? "Remove bookmark" : "Bookmark this page (Ctrl+D)";
  bookmarkBtn.setAttribute("aria-label", bookmarkBtn.title);
  bookmarkBtn.setAttribute("aria-pressed", on ? "true" : "false");
  bookmarkBtn.replaceChildren(svgIcon(on ? "starFilled" : "star"));
}

function renderRecordButton(next: AppState): void {
  const rec = next.recording;
  recordBtn.classList.toggle("on", rec.active);
  recordBtn.disabled = rec.playing;
  recordBtn.title = rec.playing
    ? "Playing recording"
    : rec.active
      ? "Stop recording"
      : "Start recording";
  recordBtn.setAttribute("aria-label", recordBtn.title);
}

function renderUpdateToast(next: AppState): void {
  const s = next.updateStatus;
  const key = `${s.state}:${s.version ?? ""}`;
  if (key === updateToastKey) return;
  updateToastKey = key;
  if (s.state === "ready") {
    toast(`Echo ${s.version} is ready`, "info", {
      label: "Restart now",
      onClick: () => void window.lb.applyUpdate(),
    });
  } else if (s.state === "mac-available") {
    toast(`Echo ${s.version} is available`, "info", {
      label: "View release",
      onClick: () => void window.lb.viewUpdateRelease(),
    });
  }
}

function toggleBookmark(): void {
  if (!state) return;
  if (state.bookmarks.activeBookmarked) {
    const url = state.tabs.find((t) => t.id === state!.activeTabId)?.url ?? "";
    void window.lb.removeBookmark(url).then((removed) => {
      if (removed) toast("Bookmark removed");
    });
  } else {
    void window.lb.addBookmark().then((added) => {
      toast(added ? "Bookmarked" : "Nothing to bookmark", added ? "ok" : "info");
    });
  }
}

function closeOverlays(): void {
  closeSuggestions();
  closePopover();
  hidePreview();
  closePalette();
  releaseAll();
  // A toast on screen still needs its strip; releaseAll just took it away.
  remeasureToasts();
}

/* ---------------------------------------------------------------- palette */

/** Left nav order, reused for the "Settings: …" palette rows. */
const SETTINGS_SECTIONS: [string, string][] = [
  ["connections", "Connections"],
  ["tools", "Tools"],
  ["transfers", "Transfers"],
  ["activity", "Activity"],
  ["recordings", "Recordings"],
  ["testing", "Testing"],
  ["appearance", "Appearance"],
  ["system", "System"],
  ["about", "About"],
  ["privacy", "Privacy"],
  ["terms", "Terms"],
];

const THEME_CYCLE: AppSettings["theme"][] = ["system", "light", "dark"];

async function cycleTheme(): Promise<void> {
  const current = state?.settings.theme ?? "system";
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
  await window.lb.updateSettings({ theme: next });
  toast(`Theme: ${next}`);
}

async function toggleCompact(): Promise<void> {
  const next = state?.settings.compactChrome !== true;
  await window.lb.updateSettings({ compactChrome: next });
  toast(next ? "Compact chrome on" : "Compact chrome off");
}

/**
 * Built fresh on every keystroke so labels track the live state: the recorder row reads
 * "Stop recording" mid-take, and there is one row per background tab. The Settings rows sit
 * at the end because eleven of them would otherwise fill the whole list before the user types.
 */
function paletteActions(): PaletteAction[] {
  const now = state;
  const actions: PaletteAction[] = [
    { id: "new-tab", label: "New tab", hint: "Ctrl+T", run: () => void window.lb.newTab() },
    {
      id: "new-incognito-tab",
      label: "New incognito tab",
      hint: "Ctrl+Shift+N",
      run: () => void window.lb.newIncognitoTab(),
    },
    {
      id: "close-tab",
      label: "Close tab",
      hint: "Ctrl+W",
      run: () => {
        const id = now?.activeTabId;
        if (id) void window.lb.closeTab(id);
      },
    },
    {
      id: "bookmark",
      label: "Bookmark this page",
      hint: "Ctrl+D",
      run: () => toggleBookmark(),
    },
  ];

  for (const tab of now?.tabs ?? []) {
    if (tab.id === now?.activeTabId) continue;
    actions.push({
      id: `tab-${tab.id}`,
      label: `Switch to tab: ${tab.title || tab.url || "New tab"}`,
      run: () => void window.lb.selectTab(tab.id),
    });
  }

  const recording = now?.recording.active === true;
  const testing = Boolean(now?.test.id);
  const paused = now?.activity.paused === true;

  actions.push(
    // The cycle is spelled out so the row is findable by the theme the user wants, not only
    // by the word "theme": matching is over the label, and "dark" is not in "Toggle theme".
    { id: "theme", label: "Toggle theme (system → light → dark)", run: () => void cycleTheme() },
    { id: "compact", label: "Toggle compact chrome", run: () => void toggleCompact() },
    {
      id: "record",
      label: recording ? "Stop recording" : "Start recording",
      run: () => void window.lb.recordToggle().then(() => toast(recording ? "Recording saved" : "Recording started")),
    },
    {
      id: "test",
      label: testing ? "End test run" : "Start test run",
      run: async () => {
        const dir = testing ? await window.lb.testEnd() : await window.lb.testStart();
        toast(testing ? `Report saved to ${dir}` : "Test run started", "ok");
      },
    },
    {
      id: "pause",
      label: paused ? "Resume assistant" : "Pause assistant",
      run: () => {
        void window.lb.setPaused(!paused);
        toast(paused ? "Assistant resumed" : "Assistant paused", paused ? "ok" : "info");
      },
    },
    {
      id: "copy-mcp-url",
      label: "Copy MCP URL",
      run: async () => {
        const url = now?.mcp.url;
        if (!url) return toast("The MCP server is not running", "error");
        await window.lb.copyText(url);
        toast("Copied", "ok");
      },
    },
    {
      id: "copy-token",
      label: "Copy token",
      run: async () => {
        const snippets = await window.lb.connectSnippets();
        if (!snippets.token) return toast("No token yet", "error");
        await window.lb.copyText(snippets.token);
        toast("Copied", "ok");
      },
    },
    { id: "open-data", label: "Open data folder", run: () => void window.lb.openUserData() },
  );

  for (const [id, label] of SETTINGS_SECTIONS) {
    actions.push({
      id: `settings-${id}`,
      label: `Settings: ${label}`,
      run: () => void openSettingsSection(id),
    });
  }

  return actions;
}

backBtn.addEventListener("click", () => void window.lb.back());
forwardBtn.addEventListener("click", () => void window.lb.forward());
reloadBtn.addEventListener("click", () => {
  if (state?.loading) void window.lb.stop();
  else void window.lb.reload();
});
newTabBtn.addEventListener("click", () => void window.lb.newTab());
menuBtn.addEventListener("click", () => void window.lb.openMenu());
recordBtn.addEventListener("click", () => {
  const wasActive = state?.recording.active === true;
  void window.lb.recordToggle().then(() => toast(wasActive ? "Recording saved" : "Recording started"));
});
bookmarkBtn.addEventListener("click", () => toggleBookmark());

window.addEventListener("resize", () => {
  closeOverlays();
  reportChromeHeight();
});

window.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  // Main already routes Ctrl+K while the page has focus; this covers the chrome itself, where
  // before-input-event on the page view never fires.
  if (mod && (key === "k" || (event.shiftKey && key === "p"))) {
    event.preventDefault();
    openPalette();
    return;
  }
  if (event.key === "Escape") closeOverlays();
});

initOmnibox(urlInput, urlForm, suggest, security);
initPalette(paletteRoot, paletteActions);
initAssistant(assistantPill, assistantPop, (section) => void openSettingsSection(section));

async function openSettingsSection(section: string): Promise<void> {
  closeOverlays();
  await openSettings(section);
  // renderSettings is a no-op while the page is hidden, so fill it on the way in.
  if (state) renderSettings(state);
}

if (window.lb) {
  initSettings(render, closeOverlays);
  initGrid();
  window.lb.onState(render);
  window.lb.onOpenSettings((section) => void openSettingsSection(section || "connections"));
  window.lb.onCloseSettings(() => hideSettings());
  window.lb.onCloseOverlays(() => closeOverlays());
  window.lb.onFocusOmnibox(() => focusOmnibox());
  window.lb.onToggleBookmark(() => toggleBookmark());
  window.lb.onOpenPalette(() => openPalette());
  void window.lb.getState().then((next) => {
    render(next);
    reportChromeHeight();
    watchChromeHeight();
    void fillSnippets();
  });
} else {
  // Opened outside Electron (design preview): show the settings page with defaults.
  initSettings(() => {});
  applyTheme({ theme: "system", compactChrome: false, homeUrl: "", evaluateEnabled: false } as AppSettings);
  void openSettings("connections");
  showSection("connections");
}

export {};
