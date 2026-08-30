import { BrowserView, BrowserWindow, net, session, nativeImage, Notification, type Session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pwBridge,
  type PwBrowser,
  type PwCdpSession,
  type PwFileChooser,
  type PwFrame,
  type PwLocatorRoot,
  type PwPage,
  type ScreencastFrame,
} from "./pw-bridge";
import { CHROME_HEIGHT, CDP_PORT, downloadsDir, partitionName } from "./paths";
import { applyChromeSession, installChromePageShim } from "./chrome-compat";
import { ECHO_SELECTORS_SOURCE } from "../shared/selector-script";
import { ASSISTANT_NAV_REFUSAL, isAssistantNavigable } from "../shared/url-policy";
import {
  FORMS_SCRIPT,
  PAGE_INFO_SCRIPT,
  CAPTCHA_SCAN_SCRIPT,
  PERF_TIMING_SCRIPT,
  dispatchKeyScript,
  fileInputKindScript,
  getTextScript,
  htmlScript,
  keyChordScript,
  linksScript,
  mouseEventScript,
  mouseEventSelectorsScript,
  tablesScript,
  visibleScript,
} from "./page-scripts";
import { elementCenterScript, moveCursorScript } from "../shared/cursor-script";
import { extractPdfText, pdfPageCount } from "./pdf-text";
import type { Recorder } from "./recordings";
import { DialogPolicies, type DialogPolicy, type DialogSeen } from "./dialogs";
import type { Downloads } from "./downloads";
import type { History } from "./history";
import type { TabInfo } from "../shared/types";
import { pace } from "./pacing";
import { RateLimiter } from "./rate-limit";

/** Shape returned by `CAPTCHA_SCAN_SCRIPT`. */
type CaptchaScan = { present?: boolean; kind?: string | null; visible?: boolean };

export type SnapshotItem = {
  ref: string;
  tag: string;
  role: string;
  name: string;
  /** Associated `<label>`, aria-label, or placeholder — what `find({ label })` matches. */
  label?: string;
  href?: string;
  inputType?: string;
  value?: string;
  selectors?: string[];
};

export type PageLink = { text: string; href: string };

export type PageTable = {
  index: number;
  caption: string;
  headers: string[];
  rows: string[][];
  totalRows: number;
};

export type FormField = { name: string; type: string; value: string; label: string; ref?: string };

export type PageForm = {
  index: number;
  name: string;
  action: string;
  method: string;
  fields: FormField[];
};

export type PageInfo = {
  title: string;
  url: string;
  description: string;
  lang: string;
  canonical: string;
  h1: string[];
  linkCount: number;
  imageCount: number;
  formCount: number;
  scripts: number;
  cookiesCount: number;
};

/** One request as `network_log` reports it. `null` fields mean the value was not available. */
export type NetworkEntry = {
  method: string;
  url: string;
  status: number | null;
  type: string;
  ms: number | null;
  bytes: number | null;
  /** ISO timestamp of when the request started. */
  at: string;
  error?: string;
};

export type PerfTiming = {
  ttfb: number | null;
  domContentLoaded: number | null;
  load: number | null;
  lcp: number | null;
  cls: number | null;
  resources: number;
};

type Tab = {
  id: string;
  /**
   * A normal tab's `BrowserView`, or — for an OSR tab (`osr: true`) — the hidden
   * `BrowserWindow` that streams its frames to the grid. Every tab-scoped method reaches the
   * page through `view.webContents`, which both types expose identically; the handful of
   * places that call a `BrowserView`-only method (`addBrowserView`/`removeBrowserView`,
   * `setBounds`) all guard on `osr` first.
   */
  view: BrowserView | BrowserWindow;
  console: string[];
  networkFailures: string[];
  /** Ring of the last `NETWORK_LOG_CAP` requests this tab made, oldest first. */
  network: NetworkEntry[];
  favicon: string | null;
  incognito: boolean;
  /**
   * True for a tab in an "applications" grid session: rendered offscreen into `paint` frames
   * the renderer draws as a grid tile, never attached to the window as the primary view.
   */
  osr: boolean;
  partition: string;
  /** Content-Type of the last main-frame response, for spotting PDFs. */
  contentType: string | null;
  /**
   * Index into this tab's `mainFrame.framesInSubtree` that snapshot/read/click target, or
   * null for the main frame. Per tab, so a frame selected on one tab cannot silently scope
   * reads on another. `frameUrl` is kept alongside it because Playwright's own frame order
   * can differ from Electron's, so the URL is the reliable way to line them up.
   */
  frameIndex: number | null;
  frameUrl: string | null;
  /**
   * The last `snapshot()` taken on this tab, keyed by ref. Per tab, so a ref handed out for
   * one tab can never resolve against another: `click("e5")` after switching tabs finds no
   * cached entry and no matching `data-lb-ref` in the new document, so it reports
   * "No element with ref ..." instead of clicking whatever happens to sit at e5 there.
   * Cleared on this tab's own main-frame navigation.
   */
  snapshotByRef: Map<string, SnapshotItem>;
};

const HOME_URL = "https://www.google.com/";
/**
 * Frame rate for OSR grid tiles. A form-filling grid needs to look live, not smooth, and
 * every frame is a full data URL over IPC, so this stays deliberately low.
 */
const GRID_FPS = 12;
/** Minimum gap between forwarded frames per tile, matching `GRID_FPS`. */
const GRID_FRAME_MS = Math.floor(1000 / GRID_FPS);
/** Most tabs one "applications" session may open at once. */
const APPS_SESSION_CAP = 6;
/**
 * One shared memory-only partition for every incognito tab (no `persist:` prefix). Cleared
 * when the last incognito tab closes — see `createTab` / `closeTab`.
 */
const INCOGNITO_PARTITION = "incognito";
/** Per-tab request ring. Matches the `network_log` cap in the tool contract. */
const NETWORK_LOG_CAP = 200;
/**
 * Resource types the request log records, and the only ones the blocking `onBeforeRequest`
 * has to see. Documents and API traffic are what `network_log` and `network_failures` report;
 * letting every image, script, font, and stylesheet round-trip through the main process would
 * put a blocking hop on the same thread as the UI and the MCP server. The paired
 * `onCompleted` / `onErrorOccurred` use the same filter so entries never arrive half-logged.
 *
 * `fetch()` is reported as `xhr` by Chromium, so it needs no entry of its own. `other` is not
 * a filterable type — Electron rejects it with "Invalid type other" — so the handful of
 * requests Chromium classifies that way (beacons, some worker traffic) are no longer logged.
 */
const NETWORK_FILTER: Electron.WebRequestFilter = {
  urls: ["*://*/*"],
  types: ["mainFrame", "subFrame", "xhr", "webSocket"],
};
/**
 * Favicons are fetched here, not by the renderer: the chrome's CSP is `img-src 'self' data:`,
 * so a remote icon URL can never be loaded there. Main downloads it in the tab's own session
 * (cookies and proxy included) and hands the renderer a small data URL.
 */
const FAVICON_TIMEOUT_MS = 5000;
const FAVICON_MAX_BYTES = 64 * 1024;
const FAVICON_CACHE_MAX = 200;
/** In-flight requests waiting for a completion event. Bounded so a stalled tab cannot leak. */
const PENDING_REQUEST_CAP = 600;
const THUMB_TTL_MS = 10_000;
const THUMB_CAPTURE_TIMEOUT_MS = 2_000;
/**
 * How long `requirePlaywrightPage()` waits for Playwright's view of the active tab to catch
 * up with Electron's.
 *
 * `navigate` resolves on Electron's load event, which happens in the browser process; the
 * matching CDP event still has to reach the Playwright client before `page.url()` changes.
 * Without this wait, a Playwright-only tool (`drag`, `upload_file`) called right after a
 * navigation reports "Playwright not attached" for a few dozen milliseconds.
 *
 * Only callers with no Electron fallback pay it. Everything else uses `playwrightPage()`,
 * which still answers immediately and falls back rather than making every click on a tab
 * Playwright cannot match — an incognito tab, say — wait for a page that will never appear.
 */
const PW_PAGE_WAIT_MS = 2_000;

export class BrowserHub {
  private window: BrowserWindow | null = null;
  private tabs = new Map<string, Tab>();
  private order: string[] = [];
  private activeId: string | null = null;
  /** One promise chain per tab id, so same-tab calls stay ordered and different-tab calls run concurrently. */
  private tabQueues = new Map<string, Promise<unknown>>();
  private pw: PwBrowser | null = null;
  private onChange: () => void = () => {};
  private seq = 0;
  private settingsOpen = false;
  /**
   * True while any OSR ("applications" grid) tab is open. A `BrowserView` always paints on
   * top of the renderer's own document, so the grid overlay it draws is invisible while a
   * regular tab is attached — this keeps that tab detached for as long as the condition
   * holds, the same technique `setSettingsOpen` uses. Set automatically from the tab list
   * (see `syncGridVisibility`) rather than toggled directly, since the grid must keep
   * showing a tab kept open via `apps_session_end({ close: false })` even after it stops
   * belonging to any tracked session.
   */
  private gridOpen = false;
  private rec: Recorder | null = null;
  /** Tabs currently mid-`watch()`, so two overlapping `watch` calls on the same tab collide instead of racing. */
  private watchingTabs = new Set<string>();
  private history: History | null = null;
  private downloads: Downloads | null = null;
  private homeUrl = HOME_URL;
  private chromeHeight = CHROME_HEIGHT;
  /** Extra strip below the chrome that the renderer is currently drawing an overlay into. */
  private overlayHeight = 0;
  /** Icon URL -> resized data URL (or "" for one that could not be decoded). */
  private faviconCache = new Map<string, string>();
  /** In-flight icon downloads, so several tabs on one site fetch it once. */
  private faviconPending = new Map<string, Promise<string>>();
  private thumbs = new Map<string, { at: number; data: string }>();
  /** When each OSR tab last had a frame forwarded, for the `GRID_FRAME_MS` throttle. */
  private lastGridFrameAt = new Map<string, number>();
  private onGridFrame: (tabId: string, dataUrl: string, width: number, height: number) => void =
    () => {};
  /** Tab ids in the open "applications" session, in the order their URLs were given. Empty when none is open. */
  private appsSessionTabIds: string[] = [];
  /** Electron's own CDP target id for each tab's webContents, once discovered (see `electronTargetId`). */
  private tabTargetIds = new Map<string, string>();
  /** Playwright Page -> its CDP target id, so repeat lookups don't pay another round trip. */
  private pageTargetIds = new WeakMap<PwPage, string>();
  /**
   * Sessions `prepareSession` has already wired up. All incognito tabs share one session, so
   * without this every new private tab added another `will-download` listener to it: one
   * download would be tracked once per tab ever opened, and the tenth tab tripped Node's
   * MaxListenersExceededWarning.
   */
  private preparedSessions = new WeakSet<Session>();
  private headerSessions = new WeakSet<Session>();
  /** Sessions whose webRequest network listeners are already installed. */
  private networkSessions = new WeakSet<Session>();
  /** Started-but-unfinished requests, keyed by `details.id`, so timing survives to onCompleted. */
  private pendingRequests = new Map<number, { tabId: string; method: string; url: string; type: string; start: number }>();
  private dialogs = new DialogPolicies();
  /** Tab ids already hooked — a fast path in front of `dialogHookedPages`. */
  private dialogHooked = new Set<string>();
  /**
   * The authority on dialog attachment. Tabs are matched to Playwright pages by URL, so two
   * tabs on the same URL can resolve to the same page; keying on the page object itself is
   * what stops a second listener being added to it.
   */
  private dialogHookedPages = new WeakSet<PwPage>();
  /** Per-host 429 backoff, consulted before assistant navigations. */
  private rateLimiter = new RateLimiter();
  /** Small randomized pauses before assistant clicks/keystrokes. Mirrors the user setting. */
  private humanPacing = true;
  /** Shows a small in-page cursor moving to the target before click/type/select/hover. Mirrors the user setting. */
  private showAssistantCursor = true;
  /** Hosts already announced as challenged this session, so the notification fires once each. */
  private captchaNotified = new Set<string>();

  setRecorder(rec: Recorder): void {
    this.rec = rec;
  }

  /** Reflects the "human pacing" setting; read live before each interaction. */
  setHumanPacing(on: boolean): void {
    this.humanPacing = on;
  }

  /** Reflects the "show assistant cursor" setting; read live before each interaction. */
  setShowAssistantCursor(on: boolean): void {
    this.showAssistantCursor = on;
  }

  setDialogs(d: DialogPolicies): void {
    this.dialogs = d;
  }

  setHistory(h: History): void {
    this.history = h;
  }

  setDownloads(d: Downloads): void {
    this.downloads = d;
  }

  setHomeUrl(url: string): void {
    if (/^https?:\/\//.test(url)) this.homeUrl = url;
  }

  /** Chrome (toolbar) height in px. The renderer reports its own measured height. */
  setChromeHeight(px: number): void {
    this.chromeHeight = Math.max(40, Math.min(160, Math.round(px)));
    this.layout();
  }

  /**
   * Room for a renderer overlay — omnibox suggestions, the assistant popover, a tab preview.
   * The page view is a native layer above the chrome document, so those panels are invisible
   * until the view slides out of the way. It slides rather than shrinks: the height stays
   * constant, so no site reflows while a dropdown is open.
   */
  setOverlayHeight(px: number): void {
    const next = Math.max(0, Math.min(720, Math.round(px)));
    if (next === this.overlayHeight) return;
    this.overlayHeight = next;
    this.layout();
  }

  setWindow(window: BrowserWindow, onChange: () => void): void {
    this.window = window;
    this.onChange = () => {
      this.syncGridVisibility();
      onChange();
    };
    this.layout();
    const relayout = () => {
      this.clearDeviceEmulation();
      this.layout();
      setTimeout(() => this.layout(), 0);
      setTimeout(() => this.layout(), 50);
    };
    window.on("resize", relayout);
    window.on("maximize", relayout);
    window.on("unmaximize", relayout);
    window.on("restore", relayout);
    window.on("enter-full-screen", relayout);
    window.on("leave-full-screen", relayout);
    this.configureSession();
  }

  setSettingsOpen(open: boolean): void {
    this.settingsOpen = open;
    if (!this.window) return;
    if (open) {
      for (const tab of this.tabs.values()) {
        // OSR tabs are hidden windows, never attached to this one — nothing to detach, and
        // they keep rendering into the grid while Settings is up.
        if (tab.osr) continue;
        try {
          this.window.removeBrowserView(tab.view as BrowserView);
        } catch {
          /* already detached */
        }
      }
    } else {
      // `activeId` may name a tab that was closed while Settings was up, so fall back to the
      // last tab in the strip, and to a fresh one if the strip is somehow empty.
      const attachable = this.attachableOrder();
      const id =
        this.activeId && this.tabs.has(this.activeId)
          ? this.activeId
          : attachable[attachable.length - 1];
      if (id) this.selectTab(id, { record: false });
      else this.createTab(this.homeUrl, { record: false });
    }
    this.onChange();
  }

  isSettingsOpen(): boolean {
    return this.settingsOpen;
  }

  /**
   * Detaches the active tab's `BrowserView` the moment any OSR tab exists, and reattaches it
   * once none do. Runs at the top of every `onChange()` (see `setWindow`), so it stays in
   * sync with `createAppsSession`, `apps_session_end`, and OSR tabs closed one at a time,
   * without those call sites needing to know about grid visibility themselves.
   */
  private syncGridVisibility(): void {
    let hasOsr = false;
    for (const t of this.tabs.values()) {
      if (t.osr) {
        hasOsr = true;
        break;
      }
    }
    if (hasOsr === this.gridOpen) return;
    this.gridOpen = hasOsr;
    if (!this.window || this.settingsOpen) return;
    const tab = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (!tab || tab.osr) return;
    if (hasOsr) {
      try {
        this.window.removeBrowserView(tab.view as BrowserView);
      } catch {
        /* already detached */
      }
    } else {
      this.window.addBrowserView(tab.view as BrowserView);
      this.layout();
    }
  }

  isLoading(): boolean {
    return this.active()?.view.webContents.isLoading() ?? false;
  }

  stop(): void {
    this.active()?.view.webContents.stop();
    this.onChange();
  }

  private configureSession(): void {
    this.prepareSession(session.fromPartition(partitionName()));
  }

  /** Chrome UA plus the shared download path, for the persistent and incognito sessions alike. */
  private prepareSession(ses: Session): void {
    if (this.preparedSessions.has(ses)) return;
    this.preparedSessions.add(ses);
    applyChromeSession(ses);
    this.trackContentType(ses);
    this.trackNetwork(ses);
    ses.on("will-download", (_event, item) => {
      const dest = path.join(downloadsDir(), item.getFilename());
      item.setSavePath(dest);
      this.downloads?.track(item, dest);
    });
  }

  /**
   * Remembers the Content-Type of each main-frame response so `pdfText` knows whether the
   * tab is showing a real PDF or an HTML page it has to print.
   *
   * A session allows only one `onHeadersReceived` listener, so this is registered once per
   * session and finds the tab by `webContentsId` rather than being wired up per tab.
   */
  private trackContentType(ses: Session): void {
    if (this.headerSessions.has(ses)) return;
    this.headerSessions.add(ses);
    // Filtered to main-frame documents so images, scripts, and XHR do not round-trip
    // through the main process on every response.
    const filter = { urls: ["*://*/*"], types: ["mainFrame" as const] };
    ses.webRequest.onHeadersReceived(filter, (details, callback) => {
      try {
        if (details.resourceType === "mainFrame") {
          const headers = details.responseHeaders ?? {};
          const key = Object.keys(headers).find((k) => k.toLowerCase() === "content-type");
          const value = key ? String(headers[key]?.[0] ?? "") : "";
          const wcId = (details as { webContentsId?: number }).webContentsId;
          for (const tab of this.tabs.values()) {
            if (tab.view.webContents.id === wcId) {
              tab.contentType = value;
              break;
            }
          }
        }
      } catch {
        /* header shapes vary; never block the response over bookkeeping */
      }
      callback({});
    });
  }

  /** The tab that owns a webContents id, or undefined for requests with no tab (workers). */
  private tabForWebContents(id: number | undefined): Tab | undefined {
    if (id === undefined) return undefined;
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed() && tab.view.webContents.id === id) return tab;
    }
    return undefined;
  }

  private pushNetwork(tab: Tab, entry: NetworkEntry): void {
    tab.network.push(entry);
    if (tab.network.length > NETWORK_LOG_CAP) tab.network = tab.network.slice(-NETWORK_LOG_CAP);
  }

  /** Content-Length off the response, when the server sent one. */
  private static bytesOf(headers: Record<string, string[]> | undefined): number | null {
    if (!headers) return null;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "content-length");
    const value = key ? Number(headers[key]?.[0]) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  /**
   * The per-tab request log, plus the main-frame failures `network_failures` reports.
   *
   * Registered once per session — Electron allows a single listener per `webRequest` event
   * per session, so anything registered per tab would clobber the tab before it. Each event
   * carries a `webContentsId`, which is how an entry finds its tab.
   */
  private trackNetwork(ses: Session): void {
    if (this.networkSessions.has(ses)) return;
    this.networkSessions.add(ses);

    ses.webRequest.onBeforeRequest(NETWORK_FILTER, (details, callback) => {
      try {
        const tab = this.tabForWebContents(details.webContentsId);
        if (tab) {
          if (this.pendingRequests.size >= PENDING_REQUEST_CAP) {
            // Oldest first: requests that never reported a completion event.
            const oldest = this.pendingRequests.keys().next();
            if (!oldest.done) this.pendingRequests.delete(oldest.value);
          }
          this.pendingRequests.set(details.id, {
            tabId: tab.id,
            method: details.method,
            url: details.url,
            type: details.resourceType,
            start: Date.now(),
          });
        }
      } catch {
        /* bookkeeping must never block a request */
      }
      callback({});
    });

    ses.webRequest.onCompleted(NETWORK_FILTER, (details) => {
      try {
        const started = this.pendingRequests.get(details.id);
        this.pendingRequests.delete(details.id);
        const tab =
          this.tabForWebContents(details.webContentsId) ??
          (started ? this.tabs.get(started.tabId) : undefined);
        if (!tab) return;
        if (details.resourceType === "mainFrame" && details.statusCode >= 400) {
          tab.networkFailures.push(`${details.statusCode} ${details.url}`.slice(0, 400));
          tab.networkFailures = tab.networkFailures.slice(-80);
        }
        // 429 from any request tells us this host wants us to back off; remember its window.
        if (details.statusCode === 429) {
          const headers = details.responseHeaders ?? {};
          const key = Object.keys(headers).find((k) => k.toLowerCase() === "retry-after");
          this.rateLimiter.note429(details.url, key ? String(headers[key]?.[0] ?? "") : undefined);
        }
        const at = started ? new Date(started.start) : new Date();
        this.pushNetwork(tab, {
          method: details.method,
          url: details.url.slice(0, 1000),
          status: details.statusCode,
          type: details.resourceType,
          ms: started ? Date.now() - started.start : null,
          bytes: BrowserHub.bytesOf(details.responseHeaders),
          at: at.toISOString(),
        });
      } catch {
        /* ignore */
      }
    });

    ses.webRequest.onErrorOccurred(NETWORK_FILTER, (details) => {
      try {
        const started = this.pendingRequests.get(details.id);
        this.pendingRequests.delete(details.id);
        const tab =
          this.tabForWebContents(details.webContentsId) ??
          (started ? this.tabs.get(started.tabId) : undefined);
        if (!tab) return;
        if (details.resourceType === "mainFrame") {
          tab.networkFailures.push(`${details.error} ${details.url}`.slice(0, 400));
          tab.networkFailures = tab.networkFailures.slice(-80);
        }
        const at = started ? new Date(started.start) : new Date();
        this.pushNetwork(tab, {
          method: details.method,
          url: details.url.slice(0, 1000),
          status: null,
          type: details.resourceType,
          ms: started ? Date.now() - started.start : null,
          bytes: null,
          at: at.toISOString(),
          error: String(details.error).slice(0, 200),
        });
      } catch {
        /* ignore */
      }
    });
  }

  async connectPlaywright(): Promise<boolean> {
    if (this.pw) return true;
    const endpoint = `http://127.0.0.1:${CDP_PORT}`;
    for (let i = 0; i < 20; i++) {
      try {
        this.pw = await pwBridge.connectOverCdp(endpoint);
        return true;
      } catch {
        await sleep(250);
      }
    }
    return false;
  }

  createTab(url?: string, opts?: { record?: boolean; incognito?: boolean }): string {
    if (!this.window) throw new Error("Window not ready");
    const id = `tab-${++this.seq}`;
    const incognito = opts?.incognito === true;
    // A non-"persist:" partition is memory-only, so an incognito tab leaves no cookies or
    // cache behind on disk. All incognito tabs share one, the way Chrome does: Electron 36
    // has no public `Session.destroy()`, so a partition per tab would strand a session and
    // its six webRequest listeners on every close. `closeTab` clears this one when the last
    // incognito tab goes away.
    const partition = incognito ? INCOGNITO_PARTITION : partitionName();
    if (incognito) this.prepareSession(session.fromPartition(partition));
    const view = new BrowserView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "..", "preload", "page.js"),
        // A BrowserView not currently attached to the window is otherwise treated as
        // backgrounded: Chromium throttles its own JS timers there (setTimeout/setInterval,
        // rAF). A page's own script — form validation, a polling widget — would then react to
        // a tabId-targeted click/type more slowly, or not at all, while its tab sits in the
        // background. Multi-tab tool calls need every tab's page script to keep running at
        // normal speed regardless of which one is attached; see `withPage` for the separate
        // fix that makes Playwright's own actions work on a detached tab at all.
        backgroundThrottling: false,
      },
    });
    const tab: Tab = {
      id,
      view,
      console: [],
      networkFailures: [],
      network: [],
      favicon: null,
      incognito,
      osr: false,
      partition,
      contentType: null,
      frameIndex: null,
      frameUrl: null,
      snapshotByRef: new Map(),
    };
    installChromePageShim(view.webContents);
    this.attachListeners(tab);
    this.tabs.set(id, tab);
    this.order.push(id);
    this.window.addBrowserView(view);
    this.selectTab(id, { record: false });
    const target = normalizeUrl(url ?? this.homeUrl);
    if (opts?.record !== false) this.rec?.record({ type: "newTab", url: target });
    void view.webContents.loadURL(target);
    this.onChange();
    return id;
  }

  /**
   * A tab for the "applications" grid: a hidden `BrowserWindow` rendered offscreen, whose
   * `paint` frames are forwarded to the renderer as grid tiles. It is never the window's
   * attached `BrowserView`.
   *
   * A hidden window rather than an offscreen `BrowserView` because an offscreen `BrowserView`
   * does not paint while detached on this Electron version (36.9.5): it emits zero `paint`
   * events and `capturePage()` returns a 0x0 image, silently — `isOffscreen()` and
   * `isPainting()` both report `true` regardless, so there is no error to catch. Offscreen
   * rendering needs a compositor host, which a detached view has no way to get.
   *
   * Every read/interact tool works on an OSR tab unchanged: they all go through
   * `tab.view.webContents`, which `BrowserWindow` exposes identically to `BrowserView`.
   */
  private createOsrTab(url: string): string {
    const id = `tab-${++this.seq}`;
    const partition = partitionName();
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "..", "preload", "page.js"),
        offscreen: true,
        // Same reason as `createTab`: an offscreen window is never foregrounded, and
        // Chromium would otherwise throttle the page's own timers while the assistant
        // works on it.
        backgroundThrottling: false,
      },
    });
    // Render no faster than `forwardGridFrame` forwards, so the throttle there drops
    // almost nothing and the compositor is not doing work that gets thrown away.
    win.webContents.setFrameRate(GRID_FPS);
    // `app.quit()` closes this window with `close()`, which runs the page's `beforeunload`.
    // A page that vetoes unload — job application forms very often do, to warn about losing a
    // half-filled draft — would cancel that close and abort the whole quit sequence, leaving
    // the user picking Quit from the tray with nothing happening and no visible window to
    // explain why. Echo owns this window and is closing it deliberately, so always allow it.
    // Normal tabs never hit this: `closeTab` uses `webContents.close()` (no beforeunload) and
    // an OSR tab closed that way is `destroy()`ed, which bypasses it too.
    win.webContents.on("will-prevent-unload", (event) => event.preventDefault());
    const tab: Tab = {
      id,
      view: win,
      console: [],
      networkFailures: [],
      network: [],
      favicon: null,
      incognito: false,
      osr: true,
      partition,
      contentType: null,
      frameIndex: null,
      frameUrl: null,
      snapshotByRef: new Map(),
    };
    installChromePageShim(win.webContents);
    this.attachListeners(tab);
    this.tabs.set(id, tab);
    this.order.push(id);
    win.webContents.on("paint", (_event, _dirty, image) => {
      this.forwardGridFrame(id, image);
    });
    win.webContents.startPainting();
    void win.webContents.loadURL(url);
    this.onChange();
    return id;
  }

  /** Where forwarded grid frames go — set by the main process to an IPC send to the chrome. */
  setGridFrameListener(
    fn: (tabId: string, dataUrl: string, width: number, height: number) => void,
  ): void {
    this.onGridFrame = fn;
  }

  /**
   * `paint` fires per damaged region, which for an animating page is far more often than a
   * grid tile needs redrawing — and each frame costs a base64 encode plus an IPC hop. The
   * window is already rendering at `GRID_FPS`, so this mostly guards against bursts.
   */
  private forwardGridFrame(tabId: string, image: Electron.NativeImage): void {
    const now = Date.now();
    const last = this.lastGridFrameAt.get(tabId) ?? 0;
    if (now - last < GRID_FRAME_MS) return;
    this.lastGridFrameAt.set(tabId, now);
    const size = image.getSize();
    if (!size.width || !size.height) return;
    this.onGridFrame(tabId, image.toDataURL(), size.width, size.height);
  }

  /**
   * Open `urls` as a grid of OSR tabs the user can watch. Returns the tab ids in the order
   * the URLs were given, for use with every tabId-addressed tool.
   */
  createAppsSession(urls: string[]): { tabIds: string[] } {
    if (!this.window) throw new Error("Window not ready");
    if (urls.length > APPS_SESSION_CAP) {
      throw new Error(
        `Applications sessions support up to ${APPS_SESSION_CAP} tabs at once, got ${urls.length}.`,
      );
    }
    if (this.appsSessionTabIds.length) {
      throw new Error("An applications session is already open. Call apps_session_end first.");
    }
    // Same policy as every other assistant-opened tab: no file:// or other local schemes.
    const targets = urls.map((url) => {
      if (!isAssistantNavigable(url)) throw new Error(ASSISTANT_NAV_REFUSAL);
      return normalizeUrl(url);
    });
    const tabIds = targets.map((url) => this.createOsrTab(url));
    this.appsSessionTabIds = tabIds;
    this.onChange();
    return { tabIds };
  }

  /**
   * Stop tracking the open session. By default its tabs are closed too.
   *
   * `close: false` keeps them: they stay OSR tabs, still addressable by tabId and still shown
   * in the grid (which lists every open OSR tab, not just the tracked session's), and they
   * simply stop counting toward the cap so the next `createAppsSession` can open a fresh
   * batch. They are deliberately not converted back into ordinary attached tabs — Electron
   * cannot re-host a window's contents as a `BrowserView`, and re-creating them would throw
   * away the half-filled form that is the whole reason to keep them.
   */
  endAppsSession(opts?: { close?: boolean }): void {
    const ids = this.appsSessionTabIds;
    this.appsSessionTabIds = [];
    if (opts?.close === false) {
      this.onChange();
      return;
    }
    for (const id of ids) {
      try {
        this.closeTab(id);
      } catch {
        /* already gone */
      }
    }
    this.onChange();
  }

  appsSessionTabs(): string[] {
    return [...this.appsSessionTabIds];
  }

  /**
   * `createTab` for anything that is not the user typing: MCP tools, recording replay, and a
   * page calling `window.open`. Only web URLs get through — see `url-policy.ts`.
   */
  assistantCreateTab(url?: string, opts?: { record?: boolean; incognito?: boolean }): string {
    if (url !== undefined && !isAssistantNavigable(url)) throw new Error(ASSISTANT_NAV_REFUSAL);
    return this.createTab(url, opts);
  }

  selectTab(id: string, opts?: { record?: boolean }): void {
    if (this.settingsOpen || this.gridOpen) return;
    const tab = this.requireTab(id);
    if (tab.osr) throw new Error("OSR tabs render in the grid, not the main view.");
    const switched = this.activeId !== id;
    // Last chance to photograph the outgoing tab: once its view is detached below,
    // capturePage() never settles.
    if (switched && this.activeId) void this.captureThumb(this.activeId);
    this.activeId = id;
    if (!this.window) return;
    for (const other of this.tabs.values()) {
      // An OSR tab's view is a hidden window, never attached, so there is nothing to detach.
      if (other.id !== id && !other.osr) {
        try {
          this.window.removeBrowserView(other.view as BrowserView);
        } catch {
          /* already detached */
        }
      }
    }
    this.window.addBrowserView(tab.view as BrowserView);
    this.layout();
    tab.view.webContents.focus();
    if (switched && opts?.record !== false) {
      const url = tab.view.webContents.getURL();
      if (url) {
        this.rec?.record({
          type: "selectTab",
          url,
          title: tab.view.webContents.getTitle() || undefined,
        });
      }
    }
    this.onChange();
  }

  closeTab(id: string): void {
    const tab = this.requireTab(id);
    // Closing the only tab must not leave an empty window, but navigating that tab home and
    // keeping it would keep everything else about it too: its incognito flag and partition,
    // its console log, its request ring, its content type, its frame selection and its dialog
    // state. Open a fresh normal tab first and then close the old one through the ordinary
    // path below, so all of that goes away and the shared incognito session is cleared when
    // the tab being closed was the last incognito one.
    // Only tabs the user can actually switch to count here: a window left with nothing but
    // OSR tabs would show a blank content area, since none of them can be attached. Counted
    // over `tabs` rather than `order` so it holds even if the two ever drift.
    let attachableLeft = 0;
    for (const other of this.tabs.values()) {
      if (!other.osr && other.id !== id) attachableLeft++;
    }
    if (attachableLeft === 0) this.createTab(this.homeUrl, { record: false });
    if (tab.osr) {
      // An OSR tab's view is a hidden BrowserWindow: it was never attached, and it is not a
      // valid argument to `removeBrowserView`. Closing only its webContents would strand the
      // window itself, so destroy the window and stop tracking its frame throttle.
      this.lastGridFrameAt.delete(id);
      (tab.view as BrowserWindow).destroy();
    } else {
      this.window?.removeBrowserView(tab.view as BrowserView);
      tab.view.webContents.close();
    }
    // Closing a session tab by hand (tabs_close, or the page closing itself) must not leave
    // the session half-open and blocking the next `apps_session_start`.
    this.appsSessionTabIds = this.appsSessionTabIds.filter((x) => x !== id);
    this.tabs.delete(id);
    this.thumbs.delete(id);
    this.dialogHooked.delete(id);
    this.dialogs.forget(id);
    this.tabQueues.delete(id);
    this.tabTargetIds.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (tab.incognito) void this.releaseIncognitoIfLast();
    if (this.activeId === id) {
      const remaining = this.attachableOrder();
      const next = remaining[remaining.length - 1];
      if (this.settingsOpen) {
        // `selectTab` does nothing while Settings is up, which would leave `activeId` pointing
        // at the tab just deleted. Move the pointer now, without touching the views (they are
        // all detached anyway); `setSettingsOpen(false)` attaches the right one.
        this.activeId = next ?? null;
        this.onChange();
      } else if (next) {
        this.selectTab(next, { record: false });
      } else {
        this.activeId = null;
        this.onChange();
      }
    } else {
      this.onChange();
    }
  }

  /**
   * Empties the shared incognito session once no incognito tab is left.
   *
   * The partition is memory-only, so nothing was written to disk, but the session object
   * itself outlives its tabs (Electron has no public `Session.destroy()`) and would otherwise
   * carry cookies and cache from a closed private tab into the next one. Best effort: a
   * failure here must never take a tab close down with it.
   */
  private async releaseIncognitoIfLast(): Promise<void> {
    for (const other of this.tabs.values()) if (other.incognito) return;
    try {
      const ses = session.fromPartition(INCOGNITO_PARTITION);
      await ses.clearStorageData();
      await ses.clearCache();
    } catch {
      /* the session may already be gone; there is nothing to recover */
    }
  }

  listTabs(): TabInfo[] {
    return this.order.map((id) => {
      const tab = this.tabs.get(id)!;
      const wc = tab.view.webContents;
      return {
        id,
        title: wc.getTitle() || "New tab",
        url: wc.getURL() || "",
        loading: wc.isLoading(),
        favicon: tab.favicon,
        incognito: tab.incognito,
        osr: tab.osr,
      };
    });
  }

  /**
   * The tabs the user can actually switch to: `order` minus OSR tabs, which have no attached
   * view and are watched in the grid instead. Every path that picks a tab to *attach* —
   * Ctrl+Tab, Ctrl+1..9, and closing the active tab — must choose from this rather than from
   * `order`, or it can land on an OSR tab and hit `selectTab`'s refusal.
   *
   * `listTabs` deliberately still reports every tab, OSR included: the assistant addresses
   * them by tabId like any other.
   */
  private attachableOrder(): string[] {
    return this.order.filter((id) => !this.tabs.get(id)?.osr);
  }

  /** Steps `delta` places through the strip, wrapping at both ends (Ctrl+Tab). */
  cycleTab(delta: number): void {
    const order = this.attachableOrder();
    if (order.length < 2 || !this.activeId) return;
    const at = order.indexOf(this.activeId);
    if (at < 0) return;
    const n = order.length;
    const next = (((at + delta) % n) + n) % n;
    this.selectTab(order[next], { record: false });
  }

  /** Selects the tab in slot `index`. Out-of-range slots do nothing, as in Chrome. */
  selectTabIndex(index: number): void {
    const id = this.attachableOrder()[index];
    if (id && id !== this.activeId) this.selectTab(id, { record: false });
  }

  tabCount(): number {
    return this.attachableOrder().length;
  }

  /** Moves a tab to `index` in the strip. Out-of-range indexes clamp to the ends. */
  reorderTab(id: string, index: number): void {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(this.order.length - 1, Math.round(index)));
    if (to === from) return;
    this.order.splice(from, 1);
    this.order.splice(to, 0, id);
    this.onChange();
  }

  /**
   * 320px-wide data URL of the tab's page, or "" when none can be produced. Never rejects.
   *
   * Only the active tab can be captured live: `selectTab` detaches every other
   * BrowserView from the window, and `capturePage()` on a detached view never
   * settles (measured: still pending after 15 s). Background tabs are therefore
   * served from the cache, which is filled while they are on screen — on
   * `did-stop-loading` and again the moment they are switched away from.
   */
  async tabThumbnail(id: string): Promise<string> {
    const cached = this.thumbs.get(id);
    if (this.activeId !== id) return cached?.data ?? "";
    if (cached && Date.now() - cached.at < THUMB_TTL_MS) return cached.data;
    return this.captureThumb(id);
  }

  /** Caches the result — empty ones included — so a miss is not retried on every hover. */
  private async captureThumb(id: string): Promise<string> {
    const tab = this.tabs.get(id);
    if (!tab) return "";
    const previous = this.thumbs.get(id)?.data ?? "";
    let data = "";
    try {
      const image = await Promise.race([
        tab.view.webContents.capturePage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), THUMB_CAPTURE_TIMEOUT_MS)),
      ]);
      if (image && !image.isEmpty()) data = image.resize({ width: 320 }).toDataURL();
    } catch {
      /* destroyed view */
    }
    // A failed re-capture keeps the last good image rather than blanking the tab.
    const kept = data || previous;
    this.thumbs.set(id, { at: Date.now(), data: kept });
    return kept;
  }

  activeTabId(): string | null {
    return this.activeId;
  }

  activeUrl(): string {
    return this.active()?.view.webContents.getURL() || "";
  }

  canGoBack(): boolean {
    const wc = this.active()?.view.webContents;
    if (!wc) return false;
    return wc.navigationHistory?.canGoBack() ?? false;
  }

  canGoForward(): boolean {
    const wc = this.active()?.view.webContents;
    if (!wc) return false;
    return wc.navigationHistory?.canGoForward() ?? false;
  }

  async navigate(url: string, tabId?: string): Promise<string> {
    const tab = tabId ? this.requireTab(tabId) : this.requireActive();
    const target = normalizeUrl(url);
    // Honor a standing 429 backoff for this host rather than hammering it.
    let backedOff = "";
    const waitMs = this.rateLimiter.waitMsFor(target);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      backedOff = ` (waited ${Math.round(waitMs / 1000)}s for a 429 rate limit)`;
    }
    this.rec?.beginIgnore();
    try {
      await tab.view.webContents.loadURL(target);
      this.rec?.record({ type: "navigate", url: target });
    } finally {
      this.rec?.endIgnore();
    }
    this.onChange();
    const landed = tab.view.webContents.getURL();
    const challenge = await this.noteCaptchaOnLoad(tab, landed);
    return `${landed}${backedOff}${challenge}`;
  }

  /**
   * After a load, checks for a CAPTCHA / anti-bot interstitial. Echo does not solve these; it
   * notifies the person at the machine (once per host) and returns a line telling the assistant
   * to pause and hand off. Best-effort: a scan failure never fails the navigation.
   */
  private async noteCaptchaOnLoad(tab: Tab, landed: string): Promise<string> {
    let found: CaptchaScan | null = null;
    try {
      found = (await this.exec(tab, CAPTCHA_SCAN_SCRIPT)) as CaptchaScan | null;
    } catch {
      return "";
    }
    if (!found?.present) return "";
    const host = (() => {
      try {
        return new URL(landed).host;
      } catch {
        return landed;
      }
    })();
    if (!this.captchaNotified.has(host)) {
      this.captchaNotified.add(host);
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: "Echo needs you: CAPTCHA",
            body: `A ${found.kind ?? "bot"} challenge is on ${host}. Solve it in the Echo window to continue.`,
          }).show();
        }
      } catch {
        /* notifications are a nicety, never required */
      }
    }
    return `\n⚠ A ${found.kind ?? "bot"} challenge is present on this page. Echo does not solve CAPTCHAs — pause and ask the user to complete it in the Echo window, then continue.`;
  }

  /** On-demand CAPTCHA scan, for the `captcha_check` tool. */
  private async detectCaptchaCore(tab: Tab): Promise<{ present: boolean; kind: string | null; visible: boolean }> {
    const found = (await this.exec(tab, CAPTCHA_SCAN_SCRIPT)) as {
      present: boolean;
      kind: string | null;
      visible: boolean;
    };
    return found;
  }

  async detectCaptcha(tabId?: string): Promise<{ present: boolean; kind: string | null; visible: boolean }> {
    return this.withTab(tabId, (tab) => this.detectCaptchaCore(tab));
  }

  /** `navigate` for assistant-driven callers. The omnibox keeps the unrestricted path. */
  async assistantNavigate(url: string, tabId?: string): Promise<string> {
    if (!isAssistantNavigable(url)) throw new Error(ASSISTANT_NAV_REFUSAL);
    return this.navigate(url, tabId);
  }

  private backCore(tab: Tab): void {
    const wc = tab.view.webContents;
    if (wc.navigationHistory?.canGoBack()) {
      wc.navigationHistory.goBack();
      this.rec?.record({ type: "back" });
    }
  }

  back(tabId?: string): Promise<void> {
    return this.withTab(tabId, async (tab) => this.backCore(tab));
  }

  forward(): void {
    const wc = this.requireActive().view.webContents;
    if (wc.navigationHistory?.canGoForward()) {
      wc.navigationHistory.goForward();
      this.rec?.record({ type: "forward" });
    }
  }

  private reloadCore(tab: Tab): void {
    const wc = tab.view.webContents;
    if (wc.isLoading()) wc.stop();
    else {
      wc.reload();
      this.rec?.record({ type: "reload" });
    }
    this.onChange();
  }

  reload(tabId?: string): Promise<void> {
    return this.withTab(tabId, async (tab) => this.reloadCore(tab));
  }

  async screenshot(filePath?: string, opts?: { fullPage?: boolean }): Promise<string> {
    const png = await this.capturePng({ fullPage: opts?.fullPage });
    return this.saveCapture(png, filePath);
  }

  saveCapture(png: Buffer, filePath?: string): string {
    const dest = filePath || path.join(downloadsDir(), `shot-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, png);
    return dest;
  }

  async captureForModel(opts?: { fullPage?: boolean; tabId?: string }): Promise<{
    jpeg: Buffer;
    width: number;
    height: number;
    png: Buffer;
  }> {
    const png = await this.capturePng({ fullPage: opts?.fullPage, tabId: opts?.tabId });
    const fitted = fitForModel(nativeImage.createFromBuffer(png));
    const size = fitted.getSize();
    return {
      png,
      jpeg: fitted.toJPEG(72),
      width: size.width,
      height: size.height,
    };
  }

  async capturePng(opts?: { fullPage?: boolean; reveal?: boolean; tabId?: string }): Promise<Buffer> {
    const tab = this.resolveTab(opts?.tabId);
    if (tab.id !== this.activeId) this.selectTab(tab.id);
    if (opts?.reveal !== false) await this.revealForCapture();
    const page = await this.playwrightPage(tab);
    if (page) {
      try {
        return await withTimeout(
          page.screenshot({ type: "png", fullPage: Boolean(opts?.fullPage), timeout: 8000 }),
          10000,
        );
      } catch {
        /* fall through to Electron capture */
      }
    }
    const image = await withTimeout(tab.view.webContents.capturePage(), 6000);
    const png = image.toPNG();
    if (!png.length) throw new Error("Screenshot was empty. Show the Echo window and try again.");
    return png;
  }

  screenshotDataUrl(): Promise<string> {
    return this.capturePng().then((png) => nativeImage.createFromBuffer(png).toDataURL());
  }

  async watch(opts?: { durationMs?: number; maxFrames?: number; tabId?: string }): Promise<{
    url: string;
    durationMs: number;
    frames: { tMs: number; jpeg: Buffer; width: number; height: number }[];
  }> {
    const tab = this.resolveTab(opts?.tabId);
    const durationMs = Math.min(6000, Math.max(800, opts?.durationMs ?? 2500));
    const maxFrames = Math.min(12, Math.max(4, opts?.maxFrames ?? 8));
    if (this.watchingTabs.has(tab.id)) throw new Error("Already watching this tab. Wait for the current live feed to finish.");
    this.watchingTabs.add(tab.id);
    try {
      if (tab.id !== this.activeId) this.selectTab(tab.id);
      await this.revealForCapture();
      const collected = await this.watchViaCdp(tab, durationMs);
      const fallback = collected.length === 0 ? await this.watchViaPoll(tab, durationMs, maxFrames) : collected;
      const unique = dedupeFrames(fallback);
      let frames = subsample(unique, maxFrames);
      if (!frames.length) {
        const still = await this.captureForModel({ tabId: tab.id });
        frames = [{ tMs: 0, jpeg: still.jpeg, width: still.width, height: still.height }];
      }
      return { url: tab.view.webContents.getURL(), durationMs, frames };
    } finally {
      this.watchingTabs.delete(tab.id);
    }
  }

  private async watchViaCdp(tab: Tab, durationMs: number): Promise<{ tMs: number; jpeg: Buffer; width: number; height: number }[]> {
    const page = await this.playwrightPage(tab);
    if (!page) return [];
    let session: PwCdpSession | null = null;
    const raw: { tMs: number; data: string }[] = [];
    const started = Date.now();
    const onFrame = (params: ScreencastFrame) => {
      raw.push({ tMs: Date.now() - started, data: params.data });
      void session?.send("Page.screencastFrameAck", { sessionId: params.sessionId });
    };
    try {
      session = await page.context().newCDPSession(page);
      session.on("Page.screencastFrame", onFrame);
      await withTimeout(
        session.send("Page.startScreencast", {
          format: "jpeg",
          quality: 52,
          maxWidth: 960,
          maxHeight: 720,
          everyNthFrame: 1,
        }),
        4000,
      );
      await sleep(durationMs);
      await session.send("Page.stopScreencast").catch(() => undefined);
    } catch {
      return [];
    } finally {
      session?.off?.("Page.screencastFrame", onFrame);
      await session?.detach().catch(() => undefined);
    }
    return raw.map((frame) => jpegFrameFromCdp(frame.data, frame.tMs));
  }

  private async watchViaPoll(
    tab: Tab,
    durationMs: number,
    maxFrames: number,
  ): Promise<{ tMs: number; jpeg: Buffer; width: number; height: number }[]> {
    const frames: { tMs: number; jpeg: Buffer; width: number; height: number }[] = [];
    const started = Date.now();
    const step = Math.max(160, Math.floor(durationMs / maxFrames));
    while (Date.now() - started < durationMs && frames.length < maxFrames) {
      const view = jpegFromPng(await this.capturePng({ reveal: false, tabId: tab.id }));
      frames.push({ tMs: Date.now() - started, ...view });
      const remaining = durationMs - (Date.now() - started);
      if (remaining <= 0) break;
      await sleep(Math.min(step, remaining));
    }
    return frames;
  }

  private async revealForCapture(): Promise<void> {
    const win = this.window;
    if (!win) throw new Error("Window not ready");
    if (this.settingsOpen) {
      win.webContents.send("close-settings");
      this.setSettingsOpen(false);
    }
    const wasHidden = !win.isVisible() || win.isMinimized();
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    this.layout();
    if (wasHidden) {
      win.focus();
      await sleep(120);
    } else {
      await sleep(30);
    }
  }

  /**
   * Runs page JavaScript in whichever frame is currently selected — the main frame unless
   * `frame_select` picked an iframe. Every ref-based read and every non-Playwright fallback
   * goes through here so a selected frame is honoured consistently.
   */
  private async exec(tab: Tab, js: string): Promise<unknown> {
    const wc = tab.view.webContents;
    if (tab.frameIndex === null) return wc.executeJavaScript(js);
    const frame = wc.mainFrame.framesInSubtree[tab.frameIndex];
    if (!frame) {
      throw new Error(`Frame ${tab.frameIndex} is gone. Call frames, then frame_select again.`);
    }
    return frame.executeJavaScript(js);
  }

  private listFramesCore(tab: Tab): { index: number; url: string; name: string }[] {
    const wc = tab.view.webContents;
    return wc.mainFrame.framesInSubtree.map((frame, index) => ({
      index,
      url: frame.url || "",
      name: frame.name || "",
    }));
  }

  listFrames(tabId?: string): Promise<{ index: number; url: string; name: string }[]> {
    return this.withTab(tabId, async (tab) => this.listFramesCore(tab));
  }

  /** Index 0 is the main frame; null also returns to it. */
  private selectFrameCore(tab: Tab, index: number | null): { index: number | null; url: string; name: string } {
    if (index === null || index === 0) {
      tab.frameIndex = null;
      tab.frameUrl = null;
      tab.snapshotByRef.clear();
      return { index: null, url: tab.view.webContents.getURL() || "", name: "" };
    }
    const frames = this.listFramesCore(tab);
    const frame = frames[index];
    if (!frame) throw new Error(`No frame at index ${index}. Call frames to list them.`);
    tab.frameIndex = index;
    tab.frameUrl = frame.url || null;
    tab.snapshotByRef.clear();
    return frame;
  }

  selectFrame(index: number | null, tabId?: string): Promise<{ index: number | null; url: string; name: string }> {
    return this.withTab(tabId, async (tab) => this.selectFrameCore(tab, index));
  }

  /** The tab's frame selection, or null when it is reading its main frame. */
  private selectedFrameCore(tab: Tab): number | null {
    return tab.frameIndex ?? null;
  }

  selectedFrame(tabId?: string): Promise<number | null> {
    return this.withTab(tabId, async (tab) => this.selectedFrameCore(tab));
  }

  private async snapshotCore(tab: Tab): Promise<SnapshotItem[]> {
    const items = (await this.exec(
      tab,
      `(() => {
      ${ECHO_SELECTORS_SOURCE}
      const sel = 'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [contenteditable="true"]';
      const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 250);
      nodes.forEach((el, i) => el.setAttribute('data-lb-ref', 'e' + i));
      return nodes.map((el, i) => {
        return {
          ref: 'e' + i,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('value') || el.getAttribute('href') || '').trim().slice(0, 120),
          label: (((el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 120)) || undefined,
          href: el.href || undefined,
          inputType: el.getAttribute('type') || undefined,
          value: el.value || undefined,
          selectors: echoSelectors(el)
        };
      });
    })()`,
    )) as SnapshotItem[];
    tab.snapshotByRef.clear();
    for (const item of items) tab.snapshotByRef.set(item.ref, item);
    return items;
  }

  async snapshot(tabId?: string): Promise<SnapshotItem[]> {
    return this.withTab(tabId, (tab) => this.snapshotCore(tab));
  }

  private async clickCore(tab: Tab, ref: string): Promise<void> {
    await pace(this.humanPacing);
    await this.moveCursorTo(tab, ref);
    const resolved = await this.resolveSelectors(tab, ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (_page, root) => {
          await root.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first().click({ timeout: 8000 });
        },
        async () => {
          const found = await this.exec(
            tab,
            `(() => {
          const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
          if (!el) return false;
          el.click();
          return true;
        })()`,
          );
          if (!found) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
        },
      );
      this.rec?.record({ type: "click", selectors: resolved.selectors, text: resolved.text });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async click(ref: string, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.clickCore(tab, ref));
  }

  private async typeTextCore(tab: Tab, ref: string, text: string, submit = false): Promise<void> {
    await pace(this.humanPacing);
    await this.moveCursorTo(tab, ref);
    const resolved = await this.resolveSelectors(tab, ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (_page, root) => {
          const loc = root.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first();
          await loc.click({ timeout: 8000 });
          await loc.fill(text);
          if (submit) await loc.press("Enter");
        },
        async () => {
          await this.exec(
            tab,
            `(() => {
          const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
          if (!el) throw new Error('ref not found');
          el.focus();
          if ('value' in el) el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`,
          );
          // A synthetic KeyboardEvent alone never triggers native Enter-to-submit, so this is
          // a second, explicit step — see `dispatchKeyScript`. Re-queries the ref rather than
          // reusing `document.activeElement`: `el.focus()` above is not guaranteed to have
          // actually moved focus (e.g. a disabled or newly-detached element).
          if (submit) {
            await this.exec(
              tab,
              dispatchKeyScript(`document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)})`, "Enter"),
            );
          }
        },
      );
      this.rec?.record({
        type: "type",
        selectors: resolved.selectors,
        text,
        submit,
        name: resolved.text,
      });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async typeText(ref: string, text: string, submit = false, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.typeTextCore(tab, ref, text, submit));
  }

  async fill(ref: string, value: string, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.typeTextCore(tab, ref, value, false));
  }

  private async pressCore(tab: Tab, key: string): Promise<void> {
    await pace(this.humanPacing);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (page) => {
          await page.keyboard.press(key);
        },
        async () => {
          await this.exec(tab, dispatchKeyScript("document.activeElement", key));
        },
      );
      this.rec?.record({ type: "press", key });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async press(key: string, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.pressCore(tab, key));
  }

  private async scrollCore(tab: Tab, deltaY: number): Promise<void> {
    await pace(this.humanPacing);
    const amount = Number(deltaY) || 600;
    await tab.view.webContents.executeJavaScript(`window.scrollBy(0, ${amount})`);
    this.rec?.record({ type: "scroll", deltaY: amount });
  }

  async scroll(deltaY: number, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.scrollCore(tab, deltaY));
  }

  private async selectCore(tab: Tab, ref: string, value: string): Promise<void> {
    await pace(this.humanPacing);
    await this.moveCursorTo(tab, ref);
    const resolved = await this.resolveSelectors(tab, ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (_page, root) => {
          await root.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first().selectOption(value);
        },
        async () => {
          await this.exec(
            tab,
            `(() => {
            const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
            if (!el) throw new Error('ref not found');
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()`,
          );
        },
      );
      this.rec?.record({ type: "select", selectors: resolved.selectors, value });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async select(ref: string, value: string, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.selectCore(tab, ref, value));
  }

  /**
   * Fills several fields from the latest snapshot in one round-trip: text/textarea via
   * `typeTextCore`, `<select>` via `selectCore`, checkbox/radio via `clickCore` (only clicked
   * when the requested value is truthy — `clickCore` toggles rather than sets, so an
   * already-checked box cannot be unchecked this way). Calls the `xCore` methods directly
   * rather than the public wrappers, since those would re-enter this tab's action queue while
   * it is already held here and deadlock. One bad ref is reported per-field rather than
   * aborting the rest.
   */
  async fillForm(
    fields: { ref: string; value: string }[],
    tabId?: string,
  ): Promise<{ ref: string; ok: boolean; error?: string }[]> {
    return this.withTab(tabId, async (tab) => {
      const results: { ref: string; ok: boolean; error?: string }[] = [];
      for (const { ref, value } of fields) {
        try {
          const item = tab.snapshotByRef.get(ref);
          const tag = (item?.tag ?? "").toLowerCase();
          const inputType = (item?.inputType ?? "").toLowerCase();
          if (tag === "select") {
            await this.selectCore(tab, ref, value);
          } else if (inputType === "checkbox" || inputType === "radio") {
            const wantChecked = value === "true" || value === "1" || value.toLowerCase() === "on";
            if (wantChecked) await this.clickCore(tab, ref);
          } else {
            await this.typeTextCore(tab, ref, value, false);
          }
          results.push({ ref, ok: true });
        } catch (e) {
          results.push({ ref, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return results;
    });
  }

  private async hoverCore(tab: Tab, ref: string): Promise<void> {
    await pace(this.humanPacing);
    await this.moveCursorTo(tab, ref);
    const resolved = await this.resolveSelectors(tab, ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (_page, root) => {
          await root.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first().hover({ timeout: 8000 });
        },
        async () => {
          const found = await this.exec(tab, mouseEventScript(ref, ["mouseover", "mouseenter", "mousemove"]));
          if (!found) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
        },
      );
      this.rec?.record({ type: "hover", selectors: resolved.selectors });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async hover(ref: string, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.hoverCore(tab, ref));
  }

  /** Recorded-playback hover: the first selector that resolves wins. */
  async hoverSelectors(selectors: string[]): Promise<void> {
    const tab = this.requireActive();
    this.rec?.beginIgnore();
    try {
      const target = await this.pwTarget(tab);
      if (target) {
        for (const sel of selectors) {
          try {
            await target.root.locator(sel).first().hover({ timeout: 2500 });
            return;
          } catch {
            /* try next selector */
          }
        }
      }
      const found = await this.exec(
        tab,
        mouseEventSelectorsScript(selectors, ["mouseover", "mouseenter", "mousemove"]),
      );
      if (!found) throw new Error("Could not find the recorded element. The page may have changed.");
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async doubleClick(ref: string): Promise<void> {
    const tab = this.requireActive();
    await pace(this.humanPacing);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (_page, root) => {
          await root.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first().dblclick({ timeout: 8000 });
        },
        async () => {
          const found = await this.exec(
            tab,
            mouseEventScript(ref, ["mousedown", "mouseup", "click", "mousedown", "mouseup", "click", "dblclick"]),
          );
          if (!found) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
        },
      );
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async rightClick(ref: string): Promise<void> {
    const tab = this.requireActive();
    await pace(this.humanPacing);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (_page, root) => {
          await root
            .locator(`[data-lb-ref="${cssEscape(ref)}"]`)
            .first()
            .click({ timeout: 8000, button: "right" });
        },
        async () => {
          const found = await this.exec(tab, mouseEventScript(ref, ["contextmenu"]));
          if (!found) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
        },
      );
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  /**
   * Drag one ref onto another, or by a pixel offset. HTML5 drag-and-drop needs a real
   * pointer sequence, which only Playwright can produce here — synthesised DOM events do not
   * drive it — so this has no executeJavaScript fallback.
   */
  async drag(fromRef: string, to: { ref?: string; dx?: number; dy?: number }): Promise<string> {
    const tab = this.requireActive();
    await pace(this.humanPacing);
    const target = await this.pwTarget(tab, { wait: true });
    if (!target) throw new Error("drag needs Playwright attached; retry in a moment");
    const from = target.root.locator(`[data-lb-ref="${cssEscape(fromRef)}"]`).first();
    if (to.ref) {
      const dest = target.root.locator(`[data-lb-ref="${cssEscape(to.ref)}"]`).first();
      await from.dragTo(dest, { timeout: 10_000 });
      return `Dragged ${fromRef} onto ${to.ref}`;
    }
    const dx = Number(to.dx) || 0;
    const dy = Number(to.dy) || 0;
    const box = await from.boundingBox({ timeout: 8000 });
    if (!box) throw new Error(`Ref ${fromRef} has no on-screen box. Call snapshot first.`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await target.page.mouse.move(x, y);
    await target.page.mouse.down();
    await target.page.mouse.move(x + dx, y + dy, { steps: 10 });
    await target.page.mouse.up();
    return `Dragged ${fromRef} by ${dx},${dy}`;
  }

  async shortcut(chord: string): Promise<void> {
    const tab = this.requireActive();
    const key = String(chord).trim();
    if (!key) throw new Error("Give a key chord, e.g. Control+Shift+P.");
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (page) => {
          await page.keyboard.press(key);
        },
        async () => {
          await this.exec(tab, keyChordScript(key));
        },
      );
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  /**
   * Uploads files through the element at `ref`. A file input gets `setInputFiles`; anything
   * else is clicked while Playwright intercepts the file chooser it is expected to open, so a
   * custom upload button never strands the session on a native dialog. Playwright only:
   * `<input type=file>` cannot be filled from page JS, and neither can a chooser.
   */
  async uploadFile(ref: string, paths: string[]): Promise<string> {
    const tab = this.requireActive();
    const files = paths.map((p) => String(p).trim()).filter(Boolean);
    if (!files.length) throw new Error("Give at least one file path.");
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) throw new Error(`No such file: ${missing.join(", ")}`);
    const target = await this.pwTarget(tab, { wait: true });
    if (!target) throw new Error("upload_file needs Playwright attached; retry in a moment");
    const kind = await this.exec(tab, fileInputKindScript(ref));
    if (kind === null) throw new Error(`No element with ref ${ref}. Call snapshot for fresh refs.`);
    const locator = target.root.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first();
    const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
    if (kind === "file-input") {
      await locator.setInputFiles(files, { timeout: 10_000 });
      return `Set ${count} on ${ref}`;
    }
    // Arm the interception before the click so the chooser can never race past it.
    const chooserWait = target.page.waitForEvent("filechooser", { timeout: 8_000 });
    chooserWait.catch(() => {});
    await locator.click({ timeout: 8_000 });
    let chooser: PwFileChooser;
    try {
      chooser = await chooserWait;
    } catch {
      throw new Error(
        `${ref} is not a file input and clicking it did not open a file chooser. Point upload_file at the page's file input or its upload button.`,
      );
    }
    if (files.length > 1 && !chooser.isMultiple()) {
      throw new Error(`The chooser ${ref} opened accepts a single file; ${files.length} were given.`);
    }
    await chooser.setFiles(files);
    return `Uploaded ${count} through the file chooser ${ref} opened`;
  }

  /** Page zoom for the active tab. Omitted/`"reset"` returns to 1. */
  zoom(factor: number | "reset"): number {
    const wc = this.requireActive().view.webContents;
    const value = factor === "reset" ? 1 : Math.max(0.25, Math.min(5, Number(factor) || 1));
    wc.setZoomFactor(value);
    return value;
  }

  /** JSON of an in-page expression, capped so a huge result cannot flood the transcript. */
  async evaluate(js: string, maxChars = 20_000): Promise<string> {
    const value = await this.exec(this.requireActive(), js);
    let json: string;
    try {
      json = JSON.stringify(value) ?? "undefined";
    } catch {
      json = String(value);
    }
    if (json.length <= maxChars) return json;
    // The marker counts against the cap, so the whole reply stays within it.
    const marker = `
[truncated at ${maxChars} chars]`;
    return json.slice(0, Math.max(0, maxChars - marker.length)) + marker;
  }

  private async waitForCore(tab: Tab, opts: { text?: string; timeoutMs?: number; record?: boolean }): Promise<void> {
    const timeout = opts.timeoutMs ?? 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (opts.text) {
        const text = await this.pageTextCore(tab);
        if (text.toLowerCase().includes(opts.text.toLowerCase())) {
          if (opts.record !== false) this.rec?.record({ type: "wait", text: opts.text, ms: timeout });
          return;
        }
      } else {
        if (!tab.view.webContents.isLoading()) return;
      }
      await sleep(250);
    }
    throw new Error("wait_for timed out");
  }

  async waitFor(opts: { text?: string; timeoutMs?: number; record?: boolean }, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.waitForCore(tab, opts));
  }

  async clickSelectors(selectors: string[], text?: string): Promise<void> {
    const tab = this.requireActive();
    this.rec?.beginIgnore();
    try {
      const target = await this.pwTarget(tab);
      if (target) {
        for (const sel of selectors) {
          try {
            await target.root.locator(sel).first().click({ timeout: 2500 });
            return;
          } catch {
            /* try next selector */
          }
        }
        if (text) {
          for (const role of ["button", "link", "tab"] as const) {
            try {
              await target.page.getByRole(role, { name: text }).first().click({ timeout: 2000 });
              return;
            } catch {
              /* try next role */
            }
          }
          try {
            await target.page.getByText(text, { exact: false }).first().click({ timeout: 2000 });
            return;
          } catch {
            /* fall through */
          }
        }
      }
      const found = await this.exec(
        tab,
        `(() => {
        const sels = ${JSON.stringify(selectors)};
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              el.scrollIntoView({ block: 'center', inline: 'nearest' });
              el.click();
              return true;
            }
          } catch (e) {}
        }
        const needle = ${JSON.stringify((text || "").trim().toLowerCase())};
        if (!needle) return false;
        const nodes = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"]'));
        const match = nodes.find((n) => {
          const label = (n.getAttribute('aria-label') || n.innerText || n.getAttribute('value') || n.getAttribute('placeholder') || '').trim().toLowerCase();
          return label === needle || (needle.length > 2 && label.indexOf(needle) !== -1);
        });
        if (!match) return false;
        match.scrollIntoView({ block: 'center', inline: 'nearest' });
        match.click();
        return true;
      })()`,
      );
      if (!found) throw new Error("Could not find the recorded element. The page may have changed.");
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async typeSelectors(selectors: string[], text: string, submit = false, name?: string): Promise<void> {
    const tab = this.requireActive();
    this.rec?.beginIgnore();
    try {
      const target = await this.pwTarget(tab);
      if (target) {
        for (const sel of selectors) {
          try {
            const loc = target.root.locator(sel).first();
            await loc.click({ timeout: 2500 });
            await loc.fill(text);
            if (submit) await loc.press("Enter");
            return;
          } catch {
            /* try next selector */
          }
        }
        if (name) {
          for (const loc of [target.page.getByPlaceholder(name), target.page.getByLabel(name)]) {
            try {
              await loc.first().click({ timeout: 2000 });
              await loc.first().fill(text);
              if (submit) await loc.first().press("Enter");
              return;
            } catch {
              /* try next */
            }
          }
        }
      }
      const found = await this.exec(
        tab,
        `(() => {
        const sels = ${JSON.stringify(selectors)};
        const value = ${JSON.stringify(text)};
        const submit = ${submit ? "true" : "false"};
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel);
            if (!el) continue;
            el.focus();
            if ('value' in el) el.value = value;
            else if (el.isContentEditable) el.textContent = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (submit) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return true;
          } catch (e) {}
        }
        return false;
      })()`,
      );
      if (!found) throw new Error("Could not find the recorded input. The page may have changed.");
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async selectSelectors(selectors: string[], value: string): Promise<void> {
    const tab = this.requireActive();
    this.rec?.beginIgnore();
    try {
      const target = await this.pwTarget(tab);
      if (target) {
        for (const sel of selectors) {
          try {
            await target.root.locator(sel).first().selectOption(value, { timeout: 2500 });
            return;
          } catch {
            /* try next */
          }
        }
      }
      const found = await this.exec(
        tab,
        `(() => {
        const sels = ${JSON.stringify(selectors)};
        const value = ${JSON.stringify(value)};
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel);
            if (!el) continue;
            el.value = value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          } catch (e) {}
        }
        return false;
      })()`,
      );
      if (!found) throw new Error("Could not find the recorded select. The page may have changed.");
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async selectorsForRef(tab: Tab, ref: string): Promise<string[]> {
    return (await this.exec(
      tab,
      `(() => {
      ${ECHO_SELECTORS_SOURCE}
      const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
      return el ? echoSelectors(el) : [];
    })()`,
    )) as string[];
  }

  private async resolveSelectors(tab: Tab, ref: string): Promise<{ selectors: string[]; text?: string }> {
    const cached = tab.snapshotByRef.get(ref);
    let live: string[] = [];
    try {
      live = await this.selectorsForRef(tab, ref);
    } catch {
      live = [];
    }
    const hrefSel =
      cached?.href && cached.href.length < 180
        ? [`a[href=${JSON.stringify(cached.href)}]`]
        : [];
    return {
      selectors: unique([...(cached?.selectors ?? []), ...live, ...hrefSel]),
      text: cached?.name || undefined,
    };
  }

  /**
   * Shows a small cosmetic cursor moving to a snapshot ref before an assistant click, type,
   * select, or hover. Purely visual — any failure here (ref gone, page navigated away, no DOM
   * to inject into) is swallowed so it never blocks the real action that follows.
   */
  private async moveCursorTo(tab: Tab, ref: string): Promise<void> {
    if (!this.showAssistantCursor) return;
    try {
      const center = (await this.exec(tab, elementCenterScript(ref))) as { x: number; y: number } | null;
      if (!center) return;
      await this.exec(tab, moveCursorScript(center.x, center.y));
    } catch {
      /* cosmetic only — never block the real action on this failing */
    }
  }

  /**
   * Visibility of one snapshot ref: true/false, or null when the ref is not on the page —
   * usually a stale snapshot rather than a hidden element, which is worth saying out loud.
   */
  async elementVisible(ref: string): Promise<boolean | null> {
    return (await this.exec(this.requireActive(), visibleScript(ref))) as boolean | null;
  }

  private async pageTextCore(tab: Tab): Promise<string> {
    return (await this.exec(tab, `document.body ? document.body.innerText : ''`)) as string;
  }

  async pageText(tabId?: string): Promise<string> {
    return this.withTab(tabId, (tab) => this.pageTextCore(tab));
  }

  async extractReadable(): Promise<{ title: string; url: string; markdown: string }> {
    const wc = this.requireActive().view.webContents;
    const data = (await wc.executeJavaScript(`(() => {
      const title = document.title || '';
      const url = location.href;
      const article = document.querySelector('article, main, [role="main"]') || document.body;
      const clone = article.cloneNode(true);
      clone.querySelectorAll('script, style, nav, footer, iframe, noscript').forEach((n) => n.remove());
      const blocks = [];
      const walk = (node) => {
        if (node.nodeType === 3) {
          const t = node.textContent.replace(/\\s+/g, ' ').trim();
          if (t) blocks.push(t);
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName.toLowerCase();
        if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
          const t = node.innerText.trim();
          if (t) blocks.push('#'.repeat(Number(tag[1])) + ' ' + t);
          return;
        }
        if (tag === 'p' || tag === 'li') {
          const t = node.innerText.trim();
          if (t) blocks.push(tag === 'li' ? '- ' + t : t);
          return;
        }
        if (tag === 'pre' || tag === 'code') {
          const t = node.innerText.trim();
          if (t) blocks.push('\`\`\`\\n' + t + '\\n\`\`\`');
          return;
        }
        node.childNodes.forEach(walk);
      };
      walk(clone);
      const seen = new Set();
      const lines = [];
      for (const b of blocks) {
        if (seen.has(b)) continue;
        seen.add(b);
        lines.push(b);
      }
      return { title, url, markdown: lines.join('\\n\\n').slice(0, 40000) };
    })()`)) as { title: string; url: string; markdown: string };
    return data;
  }

  /** Visible text of one snapshot ref, or of the whole body. */
  private async getTextCore(tab: Tab, ref: string | undefined, maxChars: number): Promise<string> {
    const cap = Math.max(1, Math.min(maxChars, 40_000));
    const value = (await this.exec(tab, getTextScript(ref ?? null, cap))) as string | null;
    if (value === null) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
    return value;
  }

  async getText(ref?: string, maxChars = 40_000, tabId?: string): Promise<string> {
    return this.withTab(tabId, (tab) => this.getTextCore(tab, ref, maxChars));
  }

  /**
   * Interactive elements matching every criterion given — text, role, and label are ANDed,
   * and an omitted one is simply not tested. Takes a fresh snapshot first, so the refs it
   * returns are the ones `click`/`type`/`fill` will resolve.
   */
  private async findCore(
    tab: Tab,
    q: { text?: string; role?: string; label?: string; limit?: number },
  ): Promise<SnapshotItem[]> {
    const items = await this.snapshotCore(tab);
    const wanted = {
      text: q.text?.trim().toLowerCase() ?? "",
      role: q.role?.trim().toLowerCase() ?? "",
      label: q.label?.trim().toLowerCase() ?? "",
    };
    const matches = items.filter((item) => {
      if (wanted.text && !(item.name ?? "").toLowerCase().includes(wanted.text)) return false;
      if (wanted.role) {
        const role = (item.role ?? "").toLowerCase();
        const tag = (item.tag ?? "").toLowerCase();
        if (role !== wanted.role && tag !== wanted.role) return false;
      }
      if (wanted.label && !(item.label ?? "").toLowerCase().includes(wanted.label)) return false;
      return true;
    });
    return matches.slice(0, Math.max(1, q.limit ?? 50));
  }

  async find(q: { text?: string; role?: string; label?: string; limit?: number }, tabId?: string): Promise<SnapshotItem[]> {
    return this.withTab(tabId, (tab) => this.findCore(tab, q));
  }

  private async linksCore(tab: Tab, filter: string | undefined, limit: number): Promise<PageLink[]> {
    const cap = Math.max(1, Math.min(limit, 300));
    return (await tab.view.webContents.executeJavaScript(linksScript(filter?.trim() || null, cap))) as PageLink[];
  }
  async links(filter?: string, limit = 300, tabId?: string): Promise<PageLink[]> {
    return this.withTab(tabId, (tab) => this.linksCore(tab, filter, limit));
  }

  private async tablesCore(tab: Tab, maxRows: number): Promise<PageTable[]> {
    return (await tab.view.webContents.executeJavaScript(tablesScript(Math.max(1, maxRows)))) as PageTable[];
  }
  async tables(maxRows = 30, tabId?: string): Promise<PageTable[]> {
    return this.withTab(tabId, (tab) => this.tablesCore(tab, maxRows));
  }

  /** Snapshots first so every interactive field carries a ref usable with `fill`. */
  private async formsCore(tab: Tab): Promise<PageForm[]> {
    await this.snapshotCore(tab);
    return (await tab.view.webContents.executeJavaScript(FORMS_SCRIPT)) as PageForm[];
  }
  async forms(tabId?: string): Promise<PageForm[]> {
    return this.withTab(tabId, (tab) => this.formsCore(tab));
  }

  private async pageInfoCore(tab: Tab): Promise<PageInfo> {
    const info = (await tab.view.webContents.executeJavaScript(PAGE_INFO_SCRIPT)) as Omit<PageInfo, "cookiesCount">;
    let cookiesCount = 0;
    try {
      const url = info.url || tab.view.webContents.getURL();
      if (/^https?:/i.test(url)) {
        cookiesCount = (await tab.view.webContents.session.cookies.get({ url })).length;
      }
    } catch {
      cookiesCount = 0;
    }
    return { ...info, cookiesCount };
  }
  async pageInfo(tabId?: string): Promise<PageInfo> {
    return this.withTab(tabId, (tab) => this.pageInfoCore(tab));
  }

  private async htmlCore(
    tab: Tab,
    ref: string | undefined,
    maxChars: number,
  ): Promise<{ html: string; truncated: boolean; total: number }> {
    const cap = Math.max(1, Math.min(maxChars, 50_000));
    // Sliced in the page: a large DOM serializes to megabytes, and all but `cap` of it would
    // cross the IPC boundary only to be thrown away here.
    const value = (await this.exec(tab, htmlScript(ref ?? null, cap))) as {
      html: string;
      truncated: boolean;
      total: number;
    } | null;
    if (value === null) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
    return value;
  }
  async html(ref?: string, maxChars = 50_000, tabId?: string): Promise<{ html: string; truncated: boolean; total: number }> {
    return this.withTab(tabId, (tab) => this.htmlCore(tab, ref, maxChars));
  }

  /**
   * Text of the PDF in the tab, or of the page printed to PDF. A real PDF is refetched with
   * `net.fetch` because the built-in viewer's DOM holds no text.
   */
  private async pdfTextCore(tab: Tab): Promise<{ title: string; text: string; pages?: number }> {
    const wc = tab.view.webContents;
    const url = wc.getURL();
    const isPdf =
      /\.pdf(\?|#|$)/i.test(url) || (tab.contentType ?? "").toLowerCase().includes("application/pdf");
    let buf: Buffer;
    if (isPdf && url.startsWith("file:")) {
      // Neither net.fetch nor session.fetch handles file: URLs, so a local PDF is read
      // straight off disk.
      try {
        buf = await fs.promises.readFile(fileURLToPath(url));
      } catch (e) {
        throw new Error(`Could not read the PDF (${e instanceof Error ? e.message : String(e)}).`);
      }
    } else if (isPdf) {
      // Fetched through the tab's own session so cookies and the Chrome UA apply — some
      // hosts serve a 403 to anything else.
      const fetcher = wc.session.fetch ? wc.session.fetch.bind(wc.session) : net.fetch;
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`Could not download the PDF (HTTP ${response.status}).`);
      buf = Buffer.from(await response.arrayBuffer());
    } else {
      buf = await wc.printToPDF({});
    }
    const text = extractPdfText(buf);
    if (text.trim().length < 20) {
      throw new Error("No extractable text (scanned PDF or no text layer).");
    }
    const pages = pdfPageCount(buf);
    return { title: wc.getTitle() || url, text, pages: pages || undefined };
  }

  async pdfText(tabId?: string): Promise<{ title: string; text: string; pages?: number }> {
    return this.withTab(tabId, (tab) => this.pdfTextCore(tab));
  }

  async searchWeb(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
    // The query is encoded into a fixed https URL, so no scheme can escape — routed through
    // the assistant guard anyway so every tool-driven tab open goes through one door.
    const id = this.assistantCreateTab(`https://www.google.com/search?hl=en&q=${encodeURIComponent(query)}`);
    const tab = this.requireTab(id);
    await waitUntil(() => !tab.view.webContents.isLoading(), 20000);
    await sleep(900);
    try {
      await this.dismissGoogleConsent(tab);
      await sleep(500);
    } catch {
      /* consent is optional */
    }
    const results = (await tab.view.webContents.executeJavaScript(`(() => {
      try {
        const items = [];
        const seen = {};
        const links = document.querySelectorAll('a');
        for (let i = 0; i < links.length && items.length < 10; i++) {
          const a = links[i];
          const heading = a.querySelector('h3');
          const title = ((heading && heading.textContent) || a.textContent || '').trim();
          let href = a.href || '';
          if (!title || title.length < 3) continue;
          if (href.indexOf('/url?') !== -1) {
            try {
              const parsed = new URL(href);
              href = parsed.searchParams.get('q') || href;
            } catch (e) {}
          }
          if (href.indexOf('http') !== 0) continue;
          if (href.indexOf('google.com/search') !== -1) continue;
          if (href.indexOf('accounts.google') !== -1) continue;
          if (seen[href]) continue;
          seen[href] = true;
          items.push({ title: title.slice(0, 160), url: href, snippet: '' });
        }
        return items;
      } catch (err) {
        return [{ title: String(err && err.message ? err.message : err), url: location.href, snippet: 'extract-error' }];
      }
    })()`)) as { title: string; url: string; snippet: string }[];
    return results;
  }

  private async dismissGoogleConsent(tab: Tab): Promise<void> {
    const url = tab.view.webContents.getURL();
    if (!/consent\.google|google\.[^/]+\/sorry|SetSID/i.test(url) && !url.includes("consent")) {
      await tab.view.webContents.executeJavaScript(`(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        const accept = buttons.find((b) => /accept all|i agree|agree/i.test(b.innerText || b.value || ''));
        if (accept) accept.click();
      })()`);
      return;
    }
    await tab.view.webContents.executeJavaScript(`(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const accept = buttons.find((b) => /accept all|i agree|agree/i.test(b.innerText || b.value || ''));
      if (accept) accept.click();
    })()`);
    await sleep(800);
  }

  consoleErrors(): string[] {
    return [...(this.active()?.console ?? [])];
  }

  networkFailures(): string[] {
    return [...(this.active()?.networkFailures ?? [])];
  }

  /** The active tab's request ring, newest first, optionally filtered by URL substring. */
  networkLog(opts?: { filter?: string; limit?: number }): NetworkEntry[] {
    const all = this.active()?.network ?? [];
    const filter = opts?.filter?.trim().toLowerCase() ?? "";
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, NETWORK_LOG_CAP));
    const matched = filter ? all.filter((e) => e.url.toLowerCase().includes(filter)) : all;
    return matched.slice(-limit).reverse();
  }

  /**
   * Navigation timing for the active tab's main frame, plus LCP/CLS from the page preload.
   * Read from the main frame regardless of `frame_select` — the numbers describe the page.
   */
  async perfTiming(): Promise<PerfTiming> {
    const wc = this.requireActive().view.webContents;
    return (await wc.executeJavaScript(PERF_TIMING_SCRIPT)) as PerfTiming;
  }

  async setViewport(width: number, height: number): Promise<void> {
    const wc = this.requireActive().view.webContents as Electron.WebContents & {
      enableDeviceEmulation?: (opts: {
        screenPosition: string;
        screenSize: { width: number; height: number };
        viewSize: { width: number; height: number };
        deviceScaleFactor: number;
        scale: number;
      }) => void;
    };
    wc.enableDeviceEmulation?.({
      screenPosition: "desktop",
      screenSize: { width, height },
      viewSize: { width, height },
      deviceScaleFactor: 1,
      scale: 1,
    });
    this.window?.setContentSize(Math.max(width, 900), height + this.chromeHeight);
    this.layout();
  }

  async startTracing(tracePath: string): Promise<boolean> {
    try {
      const page = await this.playwrightPage(this.requireActive());
      if (!page) return false;
      await page.context().tracing.start({ screenshots: true, snapshots: true });
      (this as unknown as { _tracePath?: string })._tracePath = tracePath;
      return true;
    } catch {
      return false;
    }
  }

  async stopTracing(): Promise<void> {
    try {
      const page = await this.playwrightPage(this.requireActive());
      const dest = (this as unknown as { _tracePath?: string })._tracePath;
      if (page && dest) {
        await page.context().tracing.stop({ path: dest });
      }
    } catch {
      /* ignore */
    }
  }

  layout(): void {
    if (!this.window || !this.activeId || this.settingsOpen || this.gridOpen) return;
    const tab = this.tabs.get(this.activeId);
    // `selectTab` refuses OSR tabs, so the active tab is always an attached BrowserView; the
    // guard is here so the cast below stays honest if that ever changes.
    if (!tab || tab.osr) return;
    const view = tab.view as BrowserView;
    const { width, height } = this.window.getContentBounds();
    view.setAutoResize({ width: false, height: false, horizontal: false, vertical: false });
    view.setBounds({
      x: 0,
      y: this.chromeHeight + this.overlayHeight,
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(height) - this.chromeHeight),
    });
  }

  /**
   * Turns the icon URLs Chromium reports into a data URL the chrome can render. PNG-looking
   * candidates are tried first because `nativeImage` decodes PNG and JPEG but not .ico or
   * .svg; a page that only offers those keeps `favicon: null` and shows the globe.
   */
  private async resolveFavicon(tab: Tab, icons: string[]): Promise<void> {
    const before = safeUrl(tab.view.webContents);
    const candidates = [...icons]
      .slice(0, 4)
      .sort((a, b) => Number(/\.png(\?|$)/i.test(b)) - Number(/\.png(\?|$)/i.test(a)));

    for (const url of candidates) {
      let data = "";
      if (url.startsWith("data:")) {
        data = url.length <= FAVICON_MAX_BYTES ? url : "";
      } else if (/^https?:/i.test(url)) {
        data = await this.favicon(tab.view.webContents.session, url);
      }
      if (!data) continue;
      // The tab may have navigated while the icon was in flight; that page's icon is not this one.
      if (safeUrl(tab.view.webContents) !== before) return;
      if (tab.favicon === data) return;
      tab.favicon = data;
      this.onChange();
      return;
    }
  }

  /** Cached, deduped icon download. Concurrent callers for one URL share a single request. */
  private async favicon(ses: Session, url: string): Promise<string> {
    const cached = this.faviconCache.get(url);
    if (cached !== undefined) return cached;
    const pending = this.faviconPending.get(url);
    if (pending) return pending;
    const request = fetchFavicon(ses, url).finally(() => this.faviconPending.delete(url));
    this.faviconPending.set(url, request);
    const data = await request;
    this.cacheFavicon(url, data);
    return data;
  }

  private cacheFavicon(url: string, data: string): void {
    this.faviconCache.set(url, data);
    if (this.faviconCache.size <= FAVICON_CACHE_MAX) return;
    const oldest = this.faviconCache.keys().next().value;
    if (oldest !== undefined) this.faviconCache.delete(oldest);
  }

  private clearDeviceEmulation(): void {
    const wc = this.active()?.view.webContents as Electron.WebContents & {
      disableDeviceEmulation?: () => void;
    };
    wc?.disableDeviceEmulation?.();
  }

  private attachListeners(tab: Tab): void {
    const wc = tab.view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      // `createTab` runs in main, which is not subject to the web→file navigation block a
      // renderer would hit, so a hostile page could otherwise `window.open` a local file into
      // a tab the read tools can dump. Same policy as the assistant path.
      if (isAssistantNavigable(url)) this.createTab(url, { record: false });
      return { action: "deny" };
    });
    wc.on("page-favicon-updated", (_e, icons) => {
      void this.resolveFavicon(tab, icons ?? []);
    });
    wc.on("page-title-updated", () => {
      if (!tab.incognito) this.history?.updateTitle(wc.getURL(), wc.getTitle());
      this.onChange();
    });
    wc.on("did-navigate", () => {
      tab.snapshotByRef.clear();
      // The frame tree is rebuilt by a top-level navigation, so a stale index would point at
      // a different iframe (or none). This tab goes back to reading its main frame.
      tab.frameIndex = null;
      tab.frameUrl = null;
      tab.favicon = null;
      this.thumbs.delete(tab.id);
      if (!tab.incognito) this.history?.add(wc.getURL(), wc.getTitle());
      this.onChange();
    });
    wc.on("did-navigate-in-page", () => this.onChange());
    wc.on("did-start-loading", () => this.onChange());
    wc.on("did-stop-loading", () => {
      if (this.activeId === tab.id) void this.captureThumb(tab.id);
      this.onChange();
    });
    wc.on("console-message", (_e, level, message) => {
      if (level >= 2) {
        tab.console.push(`[${level}] ${message}`.slice(0, 500));
        tab.console = tab.console.slice(-80);
      }
    });
    // Network events are NOT wired up here. `webRequest` listeners are session-scoped and a
    // session allows only one per event, so registering them per tab meant every new tab
    // silently replaced the previous tab's listener. They live in `trackNetwork` instead,
    // once per session, routed to the right tab by `webContentsId`.
  }

  private active(): Tab | undefined {
    return this.activeId ? this.tabs.get(this.activeId) : undefined;
  }

  private requireActive(): Tab {
    const tab = this.active();
    if (!tab) throw new Error("No active tab");
    return tab;
  }

  private requireTab(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`Unknown tab ${id}`);
    return tab;
  }

  private resolveTab(tabId?: string): Tab {
    return tabId ? this.requireTab(tabId) : this.requireActive();
  }

  /**
   * Runs `fn` against the resolved tab, queued behind any call already running for that same
   * tab id. Calls targeting different tabs never wait on each other. `fn` receives the tab
   * directly and should call `xCore(tab, ...)` helpers rather than public `x(tabId)` wrappers,
   * or it will enqueue onto its own slot and deadlock.
   */
  private withTab<T>(tabId: string | undefined, fn: (tab: Tab) => Promise<T>): Promise<T> {
    const tab = this.resolveTab(tabId);
    const prior = this.tabQueues.get(tab.id) ?? Promise.resolve();
    const run = prior.then(() => fn(tab), () => fn(tab));
    this.tabQueues.set(
      tab.id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Test-only seam for the queue-ordering test: `withTab` itself is private. Not registered as an MCP tool. */
  withTabForTest<T>(tabId: string | undefined, fn: (tab: Tab) => Promise<T>): Promise<T> {
    return this.withTab(tabId, fn);
  }

  /**
   * This tab's own CDP target id, via Electron's in-process debugger (not the external
   * Playwright connection). Cached per tab id since a target id is stable for the tab's
   * lifetime. Returns null on any failure (e.g. a debugger already attached by devtools) so
   * callers fall back to URL matching rather than breaking.
   */
  private async electronTargetId(tab: Tab): Promise<string | null> {
    const cached = this.tabTargetIds.get(tab.id);
    if (cached) return cached;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return null;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      const info = (await wc.debugger.sendCommand("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      const id = info.targetInfo?.targetId;
      if (id) this.tabTargetIds.set(tab.id, id);
      return id ?? null;
    } catch {
      return null;
    }
  }

  /** A Playwright page's own CDP target id, via its own CDP session (safe to hold alongside Electron's debugger — CDP targets support multiple attached sessions). */
  private async pwPageTargetId(page: PwPage): Promise<string | null> {
    const cached = this.pageTargetIds.get(page);
    if (cached) return cached;
    try {
      const session = await page.context().newCDPSession(page);
      const info = (await session.send("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      const id = info.targetInfo?.targetId ?? null;
      if (id) this.pageTargetIds.set(page, id);
      try {
        await session.detach();
      } catch {
        /* already gone */
      }
      return id;
    } catch {
      return null;
    }
  }

  private async playwrightPage(tab: Tab): Promise<PwPage | null> {
    await this.connectPlaywright();
    if (!this.pw) return null;
    const url = tab.view.webContents.getURL();
    if (!url || url.startsWith("file:")) return null;
    const pages = this.pw.contexts().flatMap((ctx) => ctx.pages());
    let page: PwPage | null = null;
    if (pages.length > 1) {
      const targetId = await this.electronTargetId(tab);
      if (targetId) {
        for (const candidate of pages) {
          if ((await this.pwPageTargetId(candidate)) === targetId) {
            page = candidate;
            break;
          }
        }
      }
    }
    if (!page) page = pages.find((p) => safePageUrl(p) === url) || null;
    if (page) this.hookDialogs(tab.id, page);
    return page;
  }

  /**
   * The Playwright page for the given tab, waiting up to `PW_PAGE_WAIT_MS` for one to show
   * up. Only for tools that cannot do the job without Playwright, so that a short lag after a
   * navigation is not reported to the assistant as "Playwright not attached".
   *
   * The URL is re-read each round, so a navigation landing mid-wait converges rather than
   * leaving the loop chasing the address the tab has already left.
   */
  private async requirePlaywrightPage(tab: Tab): Promise<PwPage | null> {
    const deadline = Date.now() + PW_PAGE_WAIT_MS;
    for (;;) {
      const url = tab.view.webContents.getURL();
      if (!url || url.startsWith("file:")) return null;
      const page = await this.playwrightPage(tab);
      if (page) return page;
      if (Date.now() >= deadline) return null;
      await sleep(100);
    }
  }

  /**
   * Answers alert/confirm/prompt on this tab according to its policy, and remembers what it
   * saw for the `dialog` tool. Registered once per tab: without a listener Playwright
   * dismisses every dialog itself, so this is also what makes "accept" possible at all.
   */
  private hookDialogs(tabId: string, page: PwPage): void {
    if (this.dialogHooked.has(tabId) && this.dialogHookedPages.has(page)) return;
    // Two tabs on the same URL resolve to the same Playwright page, so the page object — not
    // the tab id — decides whether a listener is already there.
    if (this.dialogHookedPages.has(page)) {
      this.dialogHooked.add(tabId);
      return;
    }
    this.dialogHookedPages.add(page);
    this.dialogHooked.add(tabId);
    try {
      page.on("dialog", (d) => {
        // The owning tab is resolved now, not at attach time: the page may since have been
        // re-matched to a different tab, and the tab captured at attach time may be closed.
        const owner = this.tabForPage(page);
        const policy = owner ? this.dialogs.get(owner) : { action: "dismiss" as const };
        let message = "";
        let type = "dialog";
        try {
          message = d.message();
          type = d.type();
        } catch {
          /* the dialog may already be gone */
        }
        if (owner) {
          this.dialogs.note(owner, {
            type,
            message,
            handledAs: policy.action,
            at: new Date().toISOString(),
          });
        }
        // `promptText` is only legal on a prompt dialog: CDP rejects the whole
        // `Page.handleJavaScriptDialog` call when it is sent for an alert or a confirm, and
        // Electron's own dialog manager then answers the dialog with Cancel — so passing it
        // unconditionally turned every "accept" into a dismiss.
        const done =
          policy.action === "accept"
            ? d.accept(type === "prompt" ? policy.promptText : undefined)
            : d.dismiss();
        void Promise.resolve(done).catch(() => {
          /* Electron answered the dialog first, or the page navigated away mid-dialog */
        });
      });
    } catch {
      this.dialogHooked.delete(tabId);
      this.dialogHookedPages.delete(page);
    }
  }

  /** The tab currently showing this Playwright page, preferring the active one on a tie. */
  private tabForPage(page: PwPage): string | null {
    let url = "";
    try {
      url = page.url();
    } catch {
      return null;
    }
    if (!url) return null;
    const active = this.active();
    if (active && safeUrl(active.view.webContents) === url) return active.id;
    for (const tab of this.tabs.values()) {
      if (safeUrl(tab.view.webContents) === url) return tab.id;
    }
    return null;
  }

  /**
   * Answers a JavaScript dialog for the tab that raised it, and records it for the `dialog`
   * tool. Called synchronously from the page preload's alert/confirm/prompt shim.
   *
   * This, not the Playwright listener above, is what makes an "accept" policy work. Electron
   * answers every JS dialog raised inside a `BrowserView` with Cancel within milliseconds —
   * long before a CDP `Page.handleJavaScriptDialog` round trip can land — and it refuses
   * `window.prompt` outright. The listener stays for the dialogs the page shim cannot reach,
   * such as `beforeunload`.
   */
  answerDialog(
    webContentsId: number,
    type: string,
    message: string,
  ): { accept: boolean; promptText: string | null } {
    const tab = this.tabForWebContents(webContentsId);
    const policy = tab ? this.dialogs.get(tab.id) : { action: "dismiss" as const, promptText: undefined };
    if (tab) {
      this.dialogs.note(tab.id, {
        type,
        message: String(message ?? "").slice(0, 500),
        handledAs: policy.action,
        at: new Date().toISOString(),
      });
    }
    return { accept: policy.action === "accept", promptText: policy.promptText ?? null };
  }

  setDialogPolicy(policy: DialogPolicy): void {
    this.dialogs.set(this.requireActive().id, policy);
  }

  lastDialog(): DialogSeen | null {
    return this.dialogs.last(this.requireActive().id);
  }

  // ---- Sessions and state --------------------------------------------------

  /**
   * Cookies and storage belong to the *active tab's* session, so an incognito tab reads and
   * writes its own jar rather than the persistent one.
   */
  private activeSession(): Session {
    return this.requireActive().view.webContents.session;
  }

  /** Cookie work is relative to a page unless the caller names a URL. */
  private requireCookieContext(url?: string): void {
    if (url) return;
    if (!this.activeUrl()) throw new Error("Open a page first or pass url.");
  }

  /** No url lists every cookie in the session; a url narrows it to that page. */
  async cookiesGet(url?: string): Promise<Electron.Cookie[]> {
    this.requireCookieContext(url);
    return this.activeSession().cookies.get(url ? { url } : {});
  }

  async cookiesSet(cookie: {
    name: string;
    value: string;
    url: string;
    expiresDays?: number;
    httpOnly?: boolean;
    secure?: boolean;
  }): Promise<void> {
    await this.activeSession().cookies.set({
      url: cookie.url,
      name: cookie.name,
      value: cookie.value,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      expirationDate: cookie.expiresDays ? Date.now() / 1000 + cookie.expiresDays * 86400 : undefined,
    });
  }

  /** Returns how many cookies were removed, or null when the whole jar was cleared. */
  async cookiesClear(url?: string): Promise<number | null> {
    this.requireCookieContext(url);
    const ses = this.activeSession();
    if (!url) {
      await ses.clearStorageData({ storages: ["cookies"] });
      return null;
    }
    const cookies = await ses.cookies.get({ url });
    let removed = 0;
    for (const cookie of cookies) {
      // `remove` wants a URL the cookie would be sent to, which the record itself describes.
      const host = (cookie.domain || "").replace(/^\./, "");
      if (!host) continue;
      const cookieUrl = `http${cookie.secure ? "s" : ""}://${host}${cookie.path || "/"}`;
      try {
        await ses.cookies.remove(cookieUrl, cookie.name);
        removed++;
      } catch {
        /* a cookie that will not resolve to a URL is left alone rather than failing the call */
      }
    }
    return removed;
  }

  /** JSON for one key, or an object of every key. Runs in the selected frame. */
  async storageGet(kind: "local" | "session", key?: string, maxChars = 40_000): Promise<string> {
    const store = kind === "local" ? "localStorage" : "sessionStorage";
    const read = key
      ? `s.getItem(${JSON.stringify(key)})`
      : `Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)]))`;
    const raw = String(
      await this.exec(this.requireActive(), `(() => { const s = window.${store}; return JSON.stringify(${read}); })()`),
    );
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars)}\n[truncated at ${maxChars} chars]`;
  }

  /** A null value deletes the key. */
  async storageSet(kind: "local" | "session", key: string, value: string | null): Promise<void> {
    const store = kind === "local" ? "localStorage" : "sessionStorage";
    const call =
      value === null
        ? `removeItem(${JSON.stringify(key)})`
        : `setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`;
    await this.exec(this.requireActive(), `(() => { window.${store}.${call}; return true; })()`);
  }

  /** No origin wipes the whole session (cookies, storage, caches). */
  async clearSiteData(origin?: string): Promise<void> {
    const ses = this.activeSession();
    await ses.clearStorageData(origin ? { origin } : {});
    await ses.clearCache();
  }

  /** Title of the active tab, for bookmarking the current page. */
  activeTitle(): string {
    const wc = this.active()?.view.webContents;
    if (!wc) return "";
    try {
      return wc.getTitle() || "";
    } catch {
      return "";
    }
  }

  /**
   * The Playwright page plus the locator root for the selected frame. Returns null when
   * Playwright is not attached, or when a frame is selected that Playwright cannot match —
   * the caller then falls back to `exec`, which addresses frames through Electron instead.
   */
  private async pwTarget(tab: Tab, opts?: { wait?: boolean }): Promise<{ page: PwPage; root: PwLocatorRoot } | null> {
    const page = opts?.wait ? await this.requirePlaywrightPage(tab) : await this.playwrightPage(tab);
    if (!page) return null;
    if (tab.frameIndex === null) return { page, root: page };
    const frames: PwFrame[] = page.frames();
    const byUrl = tab.frameUrl ? frames.find((f) => f.url() === tab.frameUrl) : undefined;
    const root = byUrl ?? frames[tab.frameIndex];
    if (!root) return null;
    return { page, root };
  }

  /**
   * Prefers a Playwright-driven action, falling back to a plain DOM script when Playwright is
   * not attached to `tab` — or when `tab` is not the one currently attached to the window.
   *
   * A `BrowserView` that is not attached never produces a new compositor frame (confirmed:
   * `boundingBox()` on it resolves instantly with correct coordinates, but a real synthetic
   * click or keystroke dispatched at it is silently swallowed rather than delivered — even
   * with Playwright's `force` option, which only skips *waiting*, not delivery). The fallback
   * below never depends on that: `element.click()` / setting `.value` runs entirely inside the
   * page's own script and fires the exact same events — including native default actions like
   * form submission — a real interaction would, so a background tab always takes this path
   * instead of a Playwright action that would report success while doing nothing.
   */
  private async withPage(
    tab: Tab,
    pwFn: (page: PwPage, root: PwLocatorRoot) => Promise<void>,
    fallback: () => Promise<void>,
  ): Promise<void> {
    const target = tab.id === this.activeId ? await this.pwTarget(tab) : null;
    // `pwTarget` above awaits (Playwright connection, a CDP target lookup) — long enough for a
    // different tab's `capturePng`/`watch` to call `selectTab` and detach this one in the
    // meantime. Re-check right before acting rather than trusting the decision made before that
    // await: a Playwright action started against a tab that has since gone inactive hangs or
    // silently no-ops exactly like the case this branch exists to avoid (see `withPage`'s doc
    // comment above). This narrows the race; it does not make tab selection and the action
    // atomic — a detach mid-`pwFn` (e.g. during its own internal waits) is not covered.
    if (target && tab.id === this.activeId) {
      await pwFn(target.page, target.root);
      return;
    }
    await fallback();
  }
}

/** Downloads one icon and returns a 32px data URL, or "" for anything that fails. */
async function fetchFavicon(ses: Session, url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);
  try {
    const response = await ses.fetch(url, { signal: controller.signal });
    if (!response.ok) return "";
    // Refuse an oversized icon before reading it into memory when the server declares a size.
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > FAVICON_MAX_BYTES) return "";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > FAVICON_MAX_BYTES) return "";
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return "";
    return image.resize({ width: 32 }).toDataURL();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return HOME_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z]+:/i.test(trimmed)) return trimmed;
  if (/\s/.test(trimmed) || !trimmed.includes(".")) {
    return `https://www.google.com/search?hl=en&q=${encodeURIComponent(trimmed)}`;
  }
  return `https://${trimmed}`;
}

/** `url()` throws on a closed Playwright page, which must not break the search for a live one. */
function safePageUrl(page: PwPage): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/** `getURL()` throws on a destroyed webContents, and a closing tab must not break dialogs. */
function safeUrl(wc: Electron.WebContents): string {
  try {
    return wc.getURL();
  } catch {
    return "";
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function jpegFromPng(png: Buffer): { jpeg: Buffer; width: number; height: number } {
  const fitted = fitForModel(nativeImage.createFromBuffer(png), 960, 720);
  const size = fitted.getSize();
  return { jpeg: fitted.toJPEG(58), width: size.width, height: size.height };
}

function jpegFrameFromCdp(data: string, tMs: number): { tMs: number; jpeg: Buffer; width: number; height: number } {
  const fitted = fitForModel(nativeImage.createFromBuffer(Buffer.from(data, "base64")), 960, 720);
  const size = fitted.getSize();
  return { tMs, jpeg: fitted.toJPEG(58), width: size.width, height: size.height };
}

function dedupeFrames<T extends { jpeg: Buffer }>(frames: T[]): T[] {
  const out: T[] = [];
  for (const frame of frames) {
    const prev = out[out.length - 1];
    if (prev && prev.jpeg.equals(frame.jpeg)) continue;
    out.push(frame);
  }
  return out;
}

function subsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return [items[0]];
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  }
  return out;
}

function fitForModel(image: Electron.NativeImage, maxWidth = 1280, maxHeight = 1600): Electron.NativeImage {
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return image;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  if (scale >= 1) return image;
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: "better",
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitUntil(pred: () => boolean, timeout: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("Timed out"));
      setTimeout(tick, 150);
    };
    tick();
  });
}
