import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  dialog,
  shell,
  clipboard,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import { BrowserHub } from "./browser";
import { connectSnippets, connectStatus, claudeConfigRevealTarget, registerChatGpt, registerClaudeDesktop, registerCursor } from "./connect-clients";
import { startMcpHttp } from "./mcp-http";
import { mcpLiveStatus, setMcpSessionListener } from "./mcp-sessions";
import { refreshToolAvailability, registerTools } from "../mcp/register-tools";
import { TOOL_MANIFEST } from "../shared/tool-manifest";
import { CDP_PORT, MCP_PORT_PREFERRED, MCP_PORT_SPAN, mcpPort, mcpUrl, mcpUrlForHost, userDataDir, writeMcpPortFile } from "./paths";
import { lanIPv4s } from "./net";
import { getOrCreateToken } from "./token";
import { TestRunner } from "./test-runs";
import { Recorder } from "./recordings";
import { Scheduler } from "./scheduler";
import type { AppSettings, AppState, PlayResult, Profile, RecordedAction, TransferPrefs } from "../shared/types";
import { applyChromeCommandLine } from "./chrome-compat";
import { getTransferPrefs, setTransferPrefs, enabledToolCount } from "./transfer-prefs";
import { getSettings, setSettings } from "./settings";
import { getProfile, setProfile } from "./profile";
import { cleanChromeUserAgent } from "./user-agent";
import { ActivityLog } from "./activity";
import { History } from "./history";
import { Bookmarks } from "./bookmarks";
import { Downloads } from "./downloads";
import { DialogPolicies } from "./dialogs";
import { applyUpdateNow, startUpdateChecks, status as updateStatus } from "./updater";

/**
 * End-to-end test mode (`scripts/test-tools.mjs`).
 *
 * The profile is redirected before anything else runs, because `userDataDir()` is what every
 * store — token, port file, prefs, settings, recordings, baselines — resolves its path from,
 * and several of them are read during module initialisation.
 */
const TEST_MODE = process.env.ECHO_TEST === "1";
/**
 * Set when test mode was asked for without a throwaway profile. `app.exit()` should end the
 * process on the spot, but module evaluation continuing past it would run `prepareTestProfile`
 * against the real profile — so `whenReady` checks this flag and refuses rather than trusting
 * the exit to have happened.
 */
let testModeRefused = false;
if (TEST_MODE) {
  // Test mode rewrites the prefs and settings files and switches every tool group on. Doing
  // that to the real profile would hand a full 69-tool surface to whatever is connected, so
  // a throwaway directory is not optional.
  const testUserData = process.env.ECHO_TEST_USERDATA;
  if (!testUserData) {
    console.error("ECHO_TEST=1 needs ECHO_TEST_USERDATA: refusing to run test mode against the real profile.");
    testModeRefused = true;
    app.exit(3);
  } else {
    fs.mkdirSync(testUserData, { recursive: true });
    app.setPath("userData", testUserData);
  }
}

applyChromeCommandLine();
app.setAppUserModelId("com.echo.browser");
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

const hub = new BrowserHub();
const tests = new TestRunner(hub);
const recorder = new Recorder();
const activity = new ActivityLog();
// Built in whenReady, once app.getPath("userData") is final.
let history: History;
let bookmarks: Bookmarks;
let downloads: Downloads;
let dialogs: DialogPolicies;
let scheduler: Scheduler;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let mcpListening = false;
let token = "";
let quitRequested = false;

function broadcast(): void {
  const state = getState();
  mainWindow?.webContents.send("state", state);
}

function getState(): AppState {
  const lan = lanIPv4s();
  return {
    tabs: hub.listTabs(),
    activeTabId: hub.activeTabId(),
    mcp: {
      listening: mcpListening,
      url: mcpUrl(),
      lanUrl: lan[0] ? mcpUrlForHost(lan[0]) : null,
      lanUrls: lan.map((ip) => mcpUrlForHost(ip)),
      port: mcpPort(),
    },
    connect: { ...connectStatus(), ...mcpLiveStatus() },
    test: tests.info(),
    recording: recorder.snapshot(),
    canGoBack: hub.canGoBack(),
    canGoForward: hub.canGoForward(),
    loading: hub.isLoading(),
    banner: "Anything you log in to here is visible to a connected assistant while MCP is connected.",
    version: app.getVersion(),
    transfer: getTransferPrefs(),
    platform: process.platform,
    toolCount: enabledToolCount(getTransferPrefs(), getSettings().evaluateEnabled),
    activity: activity.state(),
    settings: getSettings(),
    profile: getProfile(),
    bookmarks: { count: bookmarks.list().length, activeBookmarked: bookmarks.has(hub.activeUrl()) },
    updateStatus: updateStatus(),
  };
}

function handleShortcut(input: Electron.Input): boolean {
  if (input.type !== "keyDown") return false;
  const key = input.key.toLowerCase();
  const mod = process.platform === "darwin" ? input.meta : input.control;
  if (mod && key === "t") {
    hub.setSettingsOpen(false);
    mainWindow?.webContents.send("close-settings");
    hub.createTab();
    broadcast();
    return true;
  }
  if (mod && input.shift && key === "n") {
    hub.setSettingsOpen(false);
    mainWindow?.webContents.send("close-settings");
    hub.createTab(undefined, { incognito: true });
    broadcast();
    return true;
  }
  if (mod && key === "w") {
    const id = hub.activeTabId();
    if (id) hub.closeTab(id);
    broadcast();
    return true;
  }
  if (mod && key === "tab") {
    hub.cycleTab(input.shift ? -1 : 1);
    broadcast();
    return true;
  }
  if (mod && !input.shift && /^[1-9]$/.test(key)) {
    // Chrome's convention: 1-8 are slots, 9 is always the last tab.
    hub.selectTabIndex(key === "9" ? hub.tabCount() - 1 : Number(key) - 1);
    broadcast();
    return true;
  }
  if (mod && key === "d") {
    mainWindow?.webContents.send("toggle-bookmark");
    return true;
  }
  if (mod && key === ",") {
    hub.setSettingsOpen(true);
    mainWindow?.webContents.send("open-settings", "connections");
    broadcast();
    return true;
  }
  if (mod && (key === "k" || (input.shift && key === "p"))) {
    // The page view holds focus when the shortcut comes from a site, so the palette input
    // would open without a caret. Hand focus back to the chrome first.
    mainWindow?.webContents.focus();
    mainWindow?.webContents.send("open-palette");
    return true;
  }
  if (mod && key === "l") {
    hub.setSettingsOpen(false);
    mainWindow?.webContents.send("close-settings");
    mainWindow?.webContents.focus();
    mainWindow?.webContents.send("focus-omnibox");
    return true;
  }
  if (key === "escape") {
    if (!hub.isSettingsOpen()) return false;
    hub.setSettingsOpen(false);
    mainWindow?.webContents.send("close-settings");
    return true;
  }
  if (key === "f5" || (mod && key === "r")) {
    hub.reload();
    broadcast();
    return true;
  }
  if ((input.alt && key === "arrowleft") || (mod && key === "[")) {
    hub.back();
    broadcast();
    return true;
  }
  if ((input.alt && key === "arrowright") || (mod && key === "]")) {
    hub.forward();
    broadcast();
    return true;
  }
  return false;
}

function iconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.png");
  }
  return path.join(__dirname, "..", "icon.png");
}

function createWindow(): void {
  const startHidden = app.getLoginItemSettings().wasOpenedAsHidden;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#dee1e6",
    title: "Echo",
    icon: iconPath(),
    show: !startHidden,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hub.setWindow(mainWindow, broadcast);
  hub.createTab();

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (handleShortcut(input)) event.preventDefault();
  });

  const chrome = path.join(__dirname, "..", "renderer", "index.html");
  void mainWindow.loadFile(chrome);

  mainWindow.on("close", (event) => {
    if (!quitRequested) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function trayIcon(): Electron.NativeImage {
  const file = iconPath();
  const size = process.platform === "darwin" ? 18 : 32;
  if (fs.existsSync(file)) {
    return nativeImage.createFromPath(file).resize({ width: size, height: size });
  }
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAhUlEQVR4nO2WMQ6AIAxF/3ow3sPbOBhP5Wgc1MFBBhsTEymmYGjT/0Ia+C8tFBERfwqgBWqgsF7XwA7s1js6oAFmdzIDtj4wAEfgBHz3M+AErsDsTkZgA2q39gDs7mQErsA8uJMROANX4O5ORmABnt6d3IEjsLiTEdiA1Z2MwAHcnYnIH4l4AelLJg8n7m9FAAAAAElFTkSuQmCC";
  return nativeImage.createFromDataURL(`data:image/png;base64,${png}`);
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip("Echo");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitRequested = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => mainWindow?.show());
}

function runningFromDiskImage(): boolean {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  return app.getPath("exe").startsWith("/Volumes/");
}

function warnIfRunningFromDiskImage(): void {
  if (!runningFromDiskImage()) return;
  dialog.showMessageBoxSync({
    type: "warning",
    title: "Move Echo to Applications",
    message: "Drag Echo into the Applications folder, then open it from there.",
    detail:
      "You opened Echo from the disk image. After you eject that disk, Echo will stop working. Drag Echo to Applications, eject the disk image, and open Echo from Applications. The first time, right-click Echo and choose Open.",
    buttons: ["OK"],
  });
}

function installDockMenu(): void {
  if (process.platform !== "darwin") return;
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      {
        label: "Show Echo",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
    ]),
  );
}

function registerIpc(): void {
  ipcMain.handle("state", () => getState());
  ipcMain.handle("navigate", async (_e, url: string) => {
    await hub.navigate(url);
    broadcast();
  });
  ipcMain.handle("back", () => {
    hub.back();
    broadcast();
  });
  ipcMain.handle("forward", () => {
    hub.forward();
    broadcast();
  });
  ipcMain.handle("reload", () => {
    hub.reload();
    broadcast();
  });
  ipcMain.handle("tabs:new", () => {
    hub.createTab();
    broadcast();
  });
  ipcMain.handle("tabs:new-incognito", () => {
    hub.createTab(undefined, { incognito: true });
    broadcast();
  });
  ipcMain.handle("tabs:reorder", (_e, id: string, index: number) => {
    hub.reorderTab(id, index);
    broadcast();
  });
  ipcMain.handle("tabs:thumbnail", (_e, id: string) => hub.tabThumbnail(id));
  ipcMain.handle("chrome:overlay", (_e, px: number) => {
    hub.setOverlayHeight(px);
  });
  ipcMain.handle("stop", () => {
    hub.stop();
    broadcast();
  });
  ipcMain.handle("chrome:height", (_e, px: number) => {
    hub.setChromeHeight(px);
  });
  ipcMain.handle("tabs:select", (_e, id: string) => {
    // `attachTab`, not `selectTab`: a click in the tab strip has nowhere to show an error, and
    // rejecting the invoke would only surface as an unhandled rejection in the renderer. It
    // stays a no-op while Settings or the grid covers the content area, as it always has.
    hub.attachTab(id);
    broadcast();
  });
  ipcMain.handle("tabs:close", (_e, id: string) => {
    hub.closeTab(id);
    broadcast();
  });
  ipcMain.handle("search", async (_e, query: string) => {
    await hub.searchWeb(query);
    broadcast();
  });
  ipcMain.handle("connect:cursor", () => registerCursor(token));
  ipcMain.handle("connect:claude", () => registerClaudeDesktop(token));
  ipcMain.handle("connect:reveal-claude-config", async () => {
    const target = claudeConfigRevealTarget();
    if (fs.existsSync(target)) {
      shell.showItemInFolder(target);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await shell.openPath(path.dirname(target));
    }
    return target;
  });
  ipcMain.handle("connect:chatgpt", () => registerChatGpt(token));
  ipcMain.handle("connect:snippets", () => connectSnippets(token));
  ipcMain.handle("clipboard:write", (_e, text: string) => {
    if (typeof text === "string") clipboard.writeText(text);
  });
  ipcMain.handle("test:start", async () => {
    const dir = await tests.start();
    broadcast();
    return dir;
  });
  ipcMain.handle("test:end", async () => {
    const dir = await tests.end();
    broadcast();
    return dir;
  });
  ipcMain.handle("open-user-data", async () => {
    await shell.openPath(userDataDir());
  });
  ipcMain.handle("autostart:get", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("autostart:set", (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle("transfer:set", (_e, next: Partial<TransferPrefs>) => {
    const prefs = setTransferPrefs(next);
    // Reaches assistants that are already connected: their tool lists update in place.
    refreshToolAvailability();
    broadcast();
    return prefs;
  });
  ipcMain.handle("activity:pause", (_e, paused: boolean) => {
    activity.setPaused(Boolean(paused));
    return activity.isPaused();
  });
  ipcMain.handle("activity:clear", () => activity.clear());
  ipcMain.handle("settings:set", (_e, open: boolean) => {
    hub.setSettingsOpen(open);
    broadcast();
  });
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:update", (_e, next: Partial<AppSettings>) => {
    const s = setSettings(next);
    hub.setHomeUrl(s.homeUrl);
    hub.setHumanPacing(s.humanPacing);
    hub.setShowAssistantCursor(s.showAssistantCursor);
    // The evaluate switch lives in settings, and it gates the `evaluate` tool live.
    refreshToolAvailability();
    broadcast();
    return s;
  });
  ipcMain.handle("profile:get", () => getProfile());
  ipcMain.handle("profile:update", (_e, next: Partial<Profile>) => setProfile(next));
  ipcMain.handle("update:apply", () => {
    applyUpdateNow();
  });
  ipcMain.handle("update:view-release", () => {
    const url = updateStatus().releaseUrl;
    if (url) void shell.openExternal(url);
  });
  ipcMain.handle("bookmarks:list", () => bookmarks.list());
  ipcMain.handle("bookmarks:add", () => {
    const url = hub.activeUrl();
    if (!url) return null;
    const title = hub.listTabs().find((t) => t.id === hub.activeTabId())?.title ?? url;
    const added = bookmarks.add(url, title);
    broadcast();
    return added;
  });
  ipcMain.handle("bookmarks:remove", (_e, idOrUrl: string) => {
    const removed = bookmarks.remove(idOrUrl);
    broadcast();
    return removed;
  });
  ipcMain.handle("history:search", (_e, q: string) => history.search(String(q ?? ""), 8));
  ipcMain.handle("tools:manifest", () => TOOL_MANIFEST);
  ipcMain.handle("menu:app", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const menu = Menu.buildFromTemplate([
      {
        label: "New tab",
        accelerator: "CmdOrCtrl+T",
        click: () => {
          hub.setSettingsOpen(false);
          win?.webContents.send("close-settings");
          hub.createTab();
          broadcast();
        },
      },
      { type: "separator" },
      {
        label: "Settings",
        click: () => {
          hub.setSettingsOpen(true);
          win?.webContents.send("open-settings", "connections");
          broadcast();
        },
      },
      {
        label: "Recordings",
        click: () => {
          hub.setSettingsOpen(true);
          win?.webContents.send("open-settings", "recordings");
          broadcast();
        },
      },
      {
        label: "Transfers",
        click: () => {
          hub.setSettingsOpen(true);
          win?.webContents.send("open-settings", "transfers");
          broadcast();
        },
      },
      { type: "separator" },
      {
        label: "Privacy Policy",
        click: () => {
          hub.setSettingsOpen(true);
          win?.webContents.send("open-settings", "privacy");
          broadcast();
        },
      },
      {
        label: "Terms of Service",
        click: () => {
          hub.setSettingsOpen(true);
          win?.webContents.send("open-settings", "terms");
          broadcast();
        },
      },
    ]);
    menu.popup({ window: win ?? undefined });
  });

  ipcMain.handle("record:toggle", () => {
    if (recorder.isPlaying()) throw new Error("Wait for playback to finish.");
    if (recorder.isRecording()) recorder.stop();
    else recorder.start(undefined, hub.activeUrl() || undefined);
    broadcast();
    return recorder.snapshot();
  });
  ipcMain.handle("record:start", (_e, name?: string) => {
    recorder.start(typeof name === "string" ? name : undefined, hub.activeUrl() || undefined);
    broadcast();
    return recorder.snapshot();
  });
  ipcMain.handle("record:stop", () => {
    const rec = recorder.stop();
    broadcast();
    return rec;
  });
  ipcMain.handle("recordings:play", async (_e, id: string): Promise<PlayResult> => {
    const result = await recorder.play(id, hub);
    broadcast();
    return result;
  });
  ipcMain.handle("recordings:delete", (_e, id: string) => {
    recorder.delete(id);
    broadcast();
  });
  ipcMain.handle("recordings:rename", (_e, id: string, name: string) => {
    recorder.rename(id, name);
    broadcast();
  });
  // Synchronous by necessity: the page preload is inside window.alert/confirm/prompt and
  // cannot return to the page until it knows the tab's policy.
  ipcMain.on("echo:dialog", (event, payload: { type?: string; message?: string }) => {
    event.returnValue = hub.answerDialog(
      event.sender.id,
      String(payload?.type ?? "dialog"),
      String(payload?.message ?? ""),
    );
  });
  ipcMain.on("echo:page-event", (event, payload: RecordedAction) => {
    if (event.sender === mainWindow?.webContents) return;
    if (!recorder.isRecording() || recorder.isIgnoring()) return;
    if (!payload || typeof payload !== "object" || !payload.type) return;
    recorder.record(payload);
    broadcast();
  });
}

function isAddrInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "EADDRINUSE");
}

async function echoAlreadyRunning(): Promise<boolean> {
  for (let port = MCP_PORT_PREFERRED; port < MCP_PORT_PREFERRED + MCP_PORT_SPAN; port++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 400);
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = (await res.json()) as { ok?: boolean; name?: string; mcp?: string };
      if (json.ok === true && (json.name === "echo" || json.mcp === "/mcp")) return true;
    } catch {
      /* try next port */
    }
  }
  return false;
}

function warnAlreadyRunning(): void {
  const where =
    process.platform === "darwin"
      ? "the menu bar at the top of the screen"
      : process.platform === "linux"
        ? "the system tray"
        : "the tray by the clock";
  dialog.showMessageBoxSync({
    type: "info",
    title: "Echo is already running",
    message: `Echo is already open — look for it in ${where}.`,
    detail:
      "This extra copy did not start because the MCP port is in use. Right-click the Echo icon and choose Quit if you meant to start a fresh copy, then open Echo once.",
  });
}

/**
 * Switches every tool group on and enables `evaluate`, so the end-to-end test sees the full
 * 69-tool surface. Written before the MCP server starts, because a session registers its
 * tools from the snapshot of the prefs taken at that moment.
 */
function prepareTestProfile(): void {
  setTransferPrefs({
    snapshotPhoto: true,
    screenshotPhoto: true,
    watchFrames: true,
    readableText: true,
    skillTreeOnConnect: true,
    toolsBrowse: true,
    toolsSee: true,
    toolsSearch: true,
    toolsDebug: true,
    toolsTest: true,
    toolsRecord: true,
    toolsRead: true,
    toolsInteract: true,
    toolsState: true,
    toolsQa: true,
  });
  const home = process.env.ECHO_TEST_HOME;
  setSettings(home ? { evaluateEnabled: true, homeUrl: home } : { evaluateEnabled: true });
}

function installAppMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  void app.whenReady().then(async () => {
    // Fail closed: the exit above should already have ended the process, and if it somehow
    // did not, nothing here may touch the real profile.
    if (testModeRefused) {
      app.exit(3);
      return;
    }
    // Test mode never puts a dialog on screen: an unattended run would hang on it. A busy
    // port is reported as exit code 3 instead.
    if (TEST_MODE) {
      prepareTestProfile();
    } else if (await echoAlreadyRunning()) {
      warnAlreadyRunning();
      quitRequested = true;
      app.quit();
      return;
    }

    dialogs = new DialogPolicies();
    hub.setDialogs(dialogs);
    history = new History(userDataDir());
    bookmarks = new Bookmarks(userDataDir());
    downloads = new Downloads();
    hub.setHistory(history);
    hub.setDownloads(downloads);
    hub.setHomeUrl(getSettings().homeUrl);
    hub.setHumanPacing(getSettings().humanPacing);
    hub.setShowAssistantCursor(getSettings().showAssistantCursor);
    // OSR tabs stream their frames to the chrome, which draws them as grid tiles. Dropped
    // silently when the window is down (mid-quit, or before it exists): a lost tile frame is
    // replaced by the next one ~80ms later.
    hub.setGridFrameListener((tabId, dataUrl, width, height) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("grid:frame", { tabId, dataUrl, width, height });
    });
    // Present as the plain Chromium Echo genuinely is, so the Electron/app-name tokens in the
    // default UA don't get pages blocked or downgraded. Must be set before any tab loads.
    app.userAgentFallback = cleanChromeUserAgent(process.platform, process.versions.chrome);

    token = getOrCreateToken();
    setMcpSessionListener(broadcast);
    recorder.setOnChange(broadcast);
    activity.setOnChange(broadcast);
    startUpdateChecks(broadcast);
    hub.setRecorder(recorder);
    // A scheduled replay must not fight a live recording or another replay, so a job that
    // arrives at a busy moment is reported as skipped and simply waits for its next slot.
    scheduler = new Scheduler(userDataDir(), async (id) => {
      // Pause is the user's stop button for everything an assistant set in motion, and a
      // schedule outlives the session that created it. It has to be checked here too: the
      // per-tool pause check in `activity.wrap` never sees a replay the timer started.
      if (activity.isPaused()) return { ok: false, message: "Skipped: Echo is paused by the user." };
      if (recorder.isRecording()) return { ok: false, message: "Skipped: a recording is in progress." };
      if (recorder.isPlaying()) return { ok: false, message: "Skipped: a recording is already playing." };
      try {
        return await recorder.play(id, hub);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    });
    scheduler.start();
    registerIpc();

    try {
      await startMcpHttp(
        token,
        (server, clientName) =>
          registerTools(server, {
            hub,
            tests,
            recorder,
            activity,
            clientName,
            history,
            bookmarks,
            downloads,
            settings: getSettings,
            prefs: getTransferPrefs(),
            dialogs,
            scheduler,
          }),
        app.getVersion(),
      );
      mcpListening = true;
      writeMcpPortFile(mcpPort());
      broadcast();
    } catch (error) {
      mcpListening = false;
      broadcast();
      if (TEST_MODE) {
        console.error(
          `ECHO_TEST: MCP server did not start: ${error instanceof Error ? error.message : String(error)}`,
        );
        quitRequested = true;
        app.exit(3);
        return;
      }
      if (isAddrInUse(error) || (await echoAlreadyRunning())) {
        warnAlreadyRunning();
        quitRequested = true;
        app.quit();
        return;
      }
      void dialog.showErrorBox(
        "MCP server failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    // Do not expose Connect until the selected fallback port is listening and
    // persisted for the bridge. This prevents a fresh install from saving a
    // stale/default port during the short startup window.
    createWindow();
    createTray();
    installAppMenu();
    installDockMenu();
    app.setAboutPanelOptions({
      applicationName: "Echo",
      applicationVersion: app.getVersion(),
      copyright: "Copyright © 2026 Echo contributors",
    });
    warnIfRunningFromDiskImage();

    void hub.connectPlaywright();

    app.on("web-contents-created", (_e, contents) => {
      contents.on("before-input-event", (ev, input) => {
        if (contents === mainWindow?.webContents) return;
        if (handleShortcut(input)) ev.preventDefault();
      });
    });

    app.on("activate", () => {
      if (!mainWindow) createWindow();
      else mainWindow.show();
    });
  });
}

app.on("before-quit", () => {
  quitRequested = true;
  scheduler?.stop();
  // History writes are debounced, so the last visit of the session may still be queued.
  history?.flush();
});

app.on("window-all-closed", () => {
  /* Stay in tray / menu bar. Quit from the icon menu or Cmd+Q / the app menu. */
});
