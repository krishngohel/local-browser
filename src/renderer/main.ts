import type { AppSettings, AppState } from "../shared/types";
import { el, svgIcon } from "./ui/dom";
import { applyTheme, reportChromeHeight } from "./ui/theme";
import { renderTabs, hidePreview, invalidateTabs } from "./ui/tabs";
import { initOmnibox, renderOmnibox, focusOmnibox, closeSuggestions } from "./ui/omnibox";
import { initAssistant, renderAssistant, closePopover } from "./ui/assistant";
import { remeasureToasts, toast } from "./ui/toasts";
import { releaseAll } from "./ui/overlay";
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

let state: AppState | null = null;
let themeKey = "";

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
  renderOmnibox(next);
  renderAssistant(next);
  renderBookmark(next);
  renderRecordButton(next);
  renderSettings(next);
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
  releaseAll();
  // A toast on screen still needs its strip; releaseAll just took it away.
  remeasureToasts();
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
  if (event.key === "Escape") closeOverlays();
});

initOmnibox(urlInput, urlForm, suggest, security);
initAssistant(assistantPill, assistantPop, (section) => void openSettingsSection(section));

async function openSettingsSection(section: string): Promise<void> {
  closeOverlays();
  await openSettings(section);
  // renderSettings is a no-op while the page is hidden, so fill it on the way in.
  if (state) renderSettings(state);
}

if (window.lb) {
  initSettings(render);
  window.lb.onState(render);
  window.lb.onOpenSettings((section) => void openSettingsSection(section || "connections"));
  window.lb.onCloseSettings(() => hideSettings());
  window.lb.onFocusOmnibox(() => focusOmnibox());
  window.lb.onToggleBookmark(() => toggleBookmark());
  window.lb.onOpenPalette(() => {
    /* Command palette lands in the next task. */
  });
  void window.lb.getState().then((next) => {
    render(next);
    reportChromeHeight();
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
