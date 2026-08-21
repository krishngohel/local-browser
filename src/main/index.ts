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
import { registerTools } from "../mcp/register-tools";
import { CDP_PORT, MCP_PORT_PREFERRED, MCP_PORT_SPAN, mcpPort, mcpUrl, mcpUrlForHost, userDataDir, writeMcpPortFile } from "./paths";
import { lanIPv4s } from "./net";
import { getOrCreateToken } from "./token";
import { TestRunner } from "./test-runs";
import { Recorder } from "./recordings";
import type { AppSettings, AppState, PlayResult, RecordedAction, TransferPrefs } from "../shared/types";
import { applyChromeCommandLine } from "./chrome-compat";
import { getTransferPrefs, setTransferPrefs, enabledToolCount } from "./transfer-prefs";
import { getSettings, setSettings } from "./settings";
import { ActivityLog } from "./activity";
import { History } from "./history";
import { Bookmarks } from "./bookmarks";
import { Downloads } from "./downloads";

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
    bookmarks: { count: bookmarks.list().length, activeBookmarked: bookmarks.has(hub.activeUrl()) },
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
  if (mod && key === "w") {
    const id = hub.activeTabId();
    if (id) hub.closeTab(id);
    broadcast();
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
  ipcMain.handle("chrome:height", (_e, px: number) => {
    hub.setChromeHeight(px);
  });
  ipcMain.handle("tabs:select", (_e, id: string) => {
    hub.selectTab(id);
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
    broadcast();
    return s;
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
    if (await echoAlreadyRunning()) {
      warnAlreadyRunning();
      quitRequested = true;
      app.quit();
      return;
    }

    history = new History(userDataDir());
    bookmarks = new Bookmarks(userDataDir());
    downloads = new Downloads();
    hub.setHistory(history);
    hub.setDownloads(downloads);
    hub.setHomeUrl(getSettings().homeUrl);

    token = getOrCreateToken();
    setMcpSessionListener(broadcast);
    recorder.setOnChange(broadcast);
    activity.setOnChange(broadcast);
    hub.setRecorder(recorder);
    registerIpc();

    try {
      await startMcpHttp(token, (server) => registerTools(server, hub, tests, recorder, activity), app.getVersion());
      mcpListening = true;
      writeMcpPortFile(mcpPort());
      broadcast();
    } catch (error) {
      mcpListening = false;
      broadcast();
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
});

app.on("window-all-closed", () => {
  /* Stay in tray / menu bar. Quit from the icon menu or Cmd+Q / the app menu. */
});
