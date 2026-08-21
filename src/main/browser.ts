import { BrowserView, BrowserWindow, net, session, nativeImage, type Session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pwBridge, type PwBrowser, type PwCdpSession, type PwPage, type ScreencastFrame } from "./pw-bridge";
import { CHROME_HEIGHT, CDP_PORT, downloadsDir, partitionName } from "./paths";
import { applyChromeSession, installChromePageShim } from "./chrome-compat";
import { ECHO_SELECTORS_SOURCE } from "../shared/selector-script";
import {
  FORMS_SCRIPT,
  PAGE_INFO_SCRIPT,
  getTextScript,
  htmlScript,
  linksScript,
  tablesScript,
} from "./page-scripts";
import { extractPdfText, pdfPageCount } from "./pdf-text";
import type { Recorder } from "./recordings";
import type { Downloads } from "./downloads";
import type { History } from "./history";
import type { TabInfo } from "../shared/types";

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

type Tab = {
  id: string;
  view: BrowserView;
  console: string[];
  networkFailures: string[];
  favicon: string | null;
  incognito: boolean;
  partition: string;
  /** Content-Type of the last main-frame response, for spotting PDFs. */
  contentType: string | null;
};

const HOME_URL = "https://www.google.com/";
const THUMB_TTL_MS = 10_000;
const THUMB_CAPTURE_TIMEOUT_MS = 2_000;

export class BrowserHub {
  private window: BrowserWindow | null = null;
  private tabs = new Map<string, Tab>();
  private order: string[] = [];
  private activeId: string | null = null;
  private pw: PwBrowser | null = null;
  private onChange: () => void = () => {};
  private seq = 0;
  private settingsOpen = false;
  private rec: Recorder | null = null;
  private snapshotByRef = new Map<string, SnapshotItem>();
  private watching = false;
  private history: History | null = null;
  private downloads: Downloads | null = null;
  private homeUrl = HOME_URL;
  private chromeHeight = CHROME_HEIGHT;
  private thumbs = new Map<string, { at: number; data: string }>();
  private headerSessions = new WeakSet<Session>();

  setRecorder(rec: Recorder): void {
    this.rec = rec;
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

  setWindow(window: BrowserWindow, onChange: () => void): void {
    this.window = window;
    this.onChange = onChange;
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
        try {
          this.window.removeBrowserView(tab.view);
        } catch {
          /* already detached */
        }
      }
    } else if (this.activeId) {
      this.selectTab(this.activeId, { record: false });
    }
    this.onChange();
  }

  isSettingsOpen(): boolean {
    return this.settingsOpen;
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
    applyChromeSession(ses);
    this.trackContentType(ses);
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
    // A non-"persist:" partition is memory-only, so an incognito tab leaves no
    // cookies or cache behind. Each incognito tab gets its own.
    const partition = incognito ? `incognito-${id}` : partitionName();
    if (incognito) this.prepareSession(session.fromPartition(partition));
    const view = new BrowserView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "..", "preload", "page.js"),
      },
    });
    const tab: Tab = {
      id,
      view,
      console: [],
      networkFailures: [],
      favicon: null,
      incognito,
      partition,
      contentType: null,
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

  selectTab(id: string, opts?: { record?: boolean }): void {
    if (this.settingsOpen) return;
    const tab = this.requireTab(id);
    const switched = this.activeId !== id;
    // Last chance to photograph the outgoing tab: once its view is detached below,
    // capturePage() never settles.
    if (switched && this.activeId) void this.captureThumb(this.activeId);
    this.activeId = id;
    if (!this.window) return;
    for (const other of this.tabs.values()) {
      if (other.id !== id) {
        try {
          this.window.removeBrowserView(other.view);
        } catch {
          /* already detached */
        }
      }
    }
    this.window.addBrowserView(tab.view);
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
    if (this.tabs.size <= 1) {
      void this.navigate(this.homeUrl);
      return;
    }
    const tab = this.requireTab(id);
    this.window?.removeBrowserView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
    this.thumbs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.activeId === id) {
      this.selectTab(this.order[this.order.length - 1], { record: false });
    } else {
      this.onChange();
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
      };
    });
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
    this.rec?.beginIgnore();
    try {
      await tab.view.webContents.loadURL(target);
      this.rec?.record({ type: "navigate", url: target });
    } finally {
      this.rec?.endIgnore();
    }
    this.onChange();
    return tab.view.webContents.getURL();
  }

  back(): void {
    const wc = this.requireActive().view.webContents;
    if (wc.navigationHistory?.canGoBack()) {
      wc.navigationHistory.goBack();
      this.rec?.record({ type: "back" });
    }
  }

  forward(): void {
    const wc = this.requireActive().view.webContents;
    if (wc.navigationHistory?.canGoForward()) {
      wc.navigationHistory.goForward();
      this.rec?.record({ type: "forward" });
    }
  }

  reload(): void {
    const wc = this.requireActive().view.webContents;
    if (wc.isLoading()) wc.stop();
    else {
      wc.reload();
      this.rec?.record({ type: "reload" });
    }
    this.onChange();
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

  async captureForModel(opts?: { fullPage?: boolean }): Promise<{
    jpeg: Buffer;
    width: number;
    height: number;
    png: Buffer;
  }> {
    const png = await this.capturePng({ fullPage: opts?.fullPage });
    const fitted = fitForModel(nativeImage.createFromBuffer(png));
    const size = fitted.getSize();
    return {
      png,
      jpeg: fitted.toJPEG(72),
      width: size.width,
      height: size.height,
    };
  }

  async capturePng(opts?: { fullPage?: boolean; reveal?: boolean }): Promise<Buffer> {
    if (opts?.reveal !== false) await this.revealForCapture();
    const page = await this.playwrightPage();
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
    const wc = this.requireActive().view.webContents;
    const image = await withTimeout(wc.capturePage(), 6000);
    const png = image.toPNG();
    if (!png.length) throw new Error("Screenshot was empty. Show the Echo window and try again.");
    return png;
  }

  screenshotDataUrl(): Promise<string> {
    return this.capturePng().then((png) => nativeImage.createFromBuffer(png).toDataURL());
  }

  async watch(opts?: { durationMs?: number; maxFrames?: number }): Promise<{
    url: string;
    durationMs: number;
    frames: { tMs: number; jpeg: Buffer; width: number; height: number }[];
  }> {
    const durationMs = Math.min(6000, Math.max(800, opts?.durationMs ?? 2500));
    const maxFrames = Math.min(12, Math.max(4, opts?.maxFrames ?? 8));
    if (this.watching) throw new Error("Already watching the page. Wait for the current live feed to finish.");
    this.watching = true;
    try {
      await this.revealForCapture();
      const collected = await this.watchViaCdp(durationMs);
      const fallback = collected.length === 0 ? await this.watchViaPoll(durationMs, maxFrames) : collected;
      const unique = dedupeFrames(fallback);
      let frames = subsample(unique, maxFrames);
      if (!frames.length) {
        const still = await this.captureForModel();
        frames = [{ tMs: 0, jpeg: still.jpeg, width: still.width, height: still.height }];
      }
      return { url: this.activeUrl(), durationMs, frames };
    } finally {
      this.watching = false;
    }
  }

  private async watchViaCdp(durationMs: number): Promise<{ tMs: number; jpeg: Buffer; width: number; height: number }[]> {
    const page = await this.playwrightPage();
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
    durationMs: number,
    maxFrames: number,
  ): Promise<{ tMs: number; jpeg: Buffer; width: number; height: number }[]> {
    const frames: { tMs: number; jpeg: Buffer; width: number; height: number }[] = [];
    const started = Date.now();
    const step = Math.max(160, Math.floor(durationMs / maxFrames));
    while (Date.now() - started < durationMs && frames.length < maxFrames) {
      const view = jpegFromPng(await this.capturePng({ reveal: false }));
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

  async snapshot(): Promise<SnapshotItem[]> {
    const wc = this.requireActive().view.webContents;
    const items = (await wc.executeJavaScript(`(() => {
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
    })()`)) as SnapshotItem[];
    this.snapshotByRef = new Map(items.map((item) => [item.ref, item]));
    return items;
  }

  async click(ref: string): Promise<void> {
    const resolved = await this.resolveSelectors(ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(async (page) => {
        await page.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first().click({ timeout: 8000 });
      }, async () => {
        const found = await this.requireActive().view.webContents.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
          if (!el) return false;
          el.click();
          return true;
        })()`);
        if (!found) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
      });
      this.rec?.record({ type: "click", selectors: resolved.selectors, text: resolved.text });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async typeText(ref: string, text: string, submit = false): Promise<void> {
    const resolved = await this.resolveSelectors(ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(async (page) => {
        const loc = page.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first();
        await loc.click({ timeout: 8000 });
        await loc.fill(text);
        if (submit) await loc.press("Enter");
      }, async () => {
        await this.requireActive().view.webContents.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
          if (!el) throw new Error('ref not found');
          el.focus();
          if ('value' in el) el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      });
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

  async fill(ref: string, value: string): Promise<void> {
    await this.typeText(ref, value, false);
  }

  async press(key: string): Promise<void> {
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        async (page) => {
          await page.keyboard.press(key);
        },
        async () => {
          await this.requireActive().view.webContents.executeJavaScript(
            `document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`,
          );
        },
      );
      this.rec?.record({ type: "press", key });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async scroll(deltaY: number): Promise<void> {
    const amount = Number(deltaY) || 600;
    await this.requireActive().view.webContents.executeJavaScript(`window.scrollBy(0, ${amount})`);
    this.rec?.record({ type: "scroll", deltaY: amount });
  }

  async select(ref: string, value: string): Promise<void> {
    const resolved = await this.resolveSelectors(ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        async (page) => {
          await page.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first().selectOption(value);
        },
        async () => {
          await this.requireActive().view.webContents.executeJavaScript(`(() => {
            const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
            if (!el) throw new Error('ref not found');
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()`);
        },
      );
      this.rec?.record({ type: "select", selectors: resolved.selectors, value });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async waitFor(opts: { text?: string; timeoutMs?: number; record?: boolean }): Promise<void> {
    const timeout = opts.timeoutMs ?? 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (opts.text) {
        const text = await this.pageText();
        if (text.toLowerCase().includes(opts.text.toLowerCase())) {
          if (opts.record !== false) this.rec?.record({ type: "wait", text: opts.text, ms: timeout });
          return;
        }
      } else {
        const wc = this.requireActive().view.webContents;
        if (!wc.isLoading()) return;
      }
      await sleep(250);
    }
    throw new Error("wait_for timed out");
  }

  async clickSelectors(selectors: string[], text?: string): Promise<void> {
    this.rec?.beginIgnore();
    try {
      const page = await this.playwrightPage();
      if (page) {
        for (const sel of selectors) {
          try {
            await page.locator(sel).first().click({ timeout: 2500 });
            return;
          } catch {
            /* try next selector */
          }
        }
        if (text) {
          for (const role of ["button", "link", "tab"] as const) {
            try {
              await page.getByRole(role, { name: text }).first().click({ timeout: 2000 });
              return;
            } catch {
              /* try next role */
            }
          }
          try {
            await page.getByText(text, { exact: false }).first().click({ timeout: 2000 });
            return;
          } catch {
            /* fall through */
          }
        }
      }
      const found = await this.requireActive().view.webContents.executeJavaScript(`(() => {
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
      })()`);
      if (!found) throw new Error("Could not find the recorded element. The page may have changed.");
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async typeSelectors(selectors: string[], text: string, submit = false, name?: string): Promise<void> {
    this.rec?.beginIgnore();
    try {
      const page = await this.playwrightPage();
      if (page) {
        for (const sel of selectors) {
          try {
            const loc = page.locator(sel).first();
            await loc.click({ timeout: 2500 });
            await loc.fill(text);
            if (submit) await loc.press("Enter");
            return;
          } catch {
            /* try next selector */
          }
        }
        if (name) {
          for (const loc of [page.getByPlaceholder(name), page.getByLabel(name)]) {
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
      const found = await this.requireActive().view.webContents.executeJavaScript(`(() => {
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
      })()`);
      if (!found) throw new Error("Could not find the recorded input. The page may have changed.");
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async selectSelectors(selectors: string[], value: string): Promise<void> {
    this.rec?.beginIgnore();
    try {
      const page = await this.playwrightPage();
      if (page) {
        for (const sel of selectors) {
          try {
            await page.locator(sel).first().selectOption(value, { timeout: 2500 });
            return;
          } catch {
            /* try next */
          }
        }
      }
      const found = await this.requireActive().view.webContents.executeJavaScript(`(() => {
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
      })()`);
      if (!found) throw new Error("Could not find the recorded select. The page may have changed.");
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async selectorsForRef(ref: string): Promise<string[]> {
    return (await this.requireActive().view.webContents.executeJavaScript(`(() => {
      ${ECHO_SELECTORS_SOURCE}
      const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
      return el ? echoSelectors(el) : [];
    })()`)) as string[];
  }

  private async resolveSelectors(ref: string): Promise<{ selectors: string[]; text?: string }> {
    const cached = this.snapshotByRef.get(ref);
    let live: string[] = [];
    try {
      live = await this.selectorsForRef(ref);
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

  async pageText(): Promise<string> {
    return (await this.requireActive().view.webContents.executeJavaScript(
      `document.body ? document.body.innerText : ''`,
    )) as string;
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
  async getText(ref?: string, maxChars = 40_000): Promise<string> {
    const wc = this.requireActive().view.webContents;
    const cap = Math.max(1, Math.min(maxChars, 40_000));
    const value = (await wc.executeJavaScript(getTextScript(ref ?? null, cap))) as string | null;
    if (value === null) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
    return value;
  }

  /**
   * Interactive elements matching every criterion given — text, role, and label are ANDed,
   * and an omitted one is simply not tested. Takes a fresh snapshot first, so the refs it
   * returns are the ones `click`/`type`/`fill` will resolve.
   */
  async find(q: { text?: string; role?: string; label?: string; limit?: number }): Promise<SnapshotItem[]> {
    const items = await this.snapshot();
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

  async links(filter?: string, limit = 300): Promise<PageLink[]> {
    const wc = this.requireActive().view.webContents;
    const cap = Math.max(1, Math.min(limit, 300));
    return (await wc.executeJavaScript(linksScript(filter?.trim() || null, cap))) as PageLink[];
  }

  async tables(maxRows = 30): Promise<PageTable[]> {
    const wc = this.requireActive().view.webContents;
    return (await wc.executeJavaScript(tablesScript(Math.max(1, maxRows)))) as PageTable[];
  }

  /** Snapshots first so every interactive field carries a ref usable with `fill`. */
  async forms(): Promise<PageForm[]> {
    await this.snapshot();
    const wc = this.requireActive().view.webContents;
    return (await wc.executeJavaScript(FORMS_SCRIPT)) as PageForm[];
  }

  async pageInfo(): Promise<PageInfo> {
    const tab = this.requireActive();
    const info = (await tab.view.webContents.executeJavaScript(PAGE_INFO_SCRIPT)) as Omit<
      PageInfo,
      "cookiesCount"
    >;
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

  async html(ref?: string, maxChars = 50_000): Promise<{ html: string; truncated: boolean; total: number }> {
    const wc = this.requireActive().view.webContents;
    const cap = Math.max(1, Math.min(maxChars, 50_000));
    // Sliced in the page: a large DOM serializes to megabytes, and all but `cap` of it would
    // cross the IPC boundary only to be thrown away here.
    const value = (await wc.executeJavaScript(htmlScript(ref ?? null, cap))) as {
      html: string;
      truncated: boolean;
      total: number;
    } | null;
    if (value === null) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
    return value;
  }

  /**
   * Text of the PDF in the tab, or of the page printed to PDF. A real PDF is refetched with
   * `net.fetch` because the built-in viewer's DOM holds no text.
   */
  async pdfText(): Promise<{ title: string; text: string; pages?: number }> {
    const tab = this.requireActive();
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

  async searchWeb(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
    const id = this.createTab(`https://www.google.com/search?hl=en&q=${encodeURIComponent(query)}`);
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
      const page = await this.playwrightPage();
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
      const page = await this.playwrightPage();
      const dest = (this as unknown as { _tracePath?: string })._tracePath;
      if (page && dest) {
        await page.context().tracing.stop({ path: dest });
      }
    } catch {
      /* ignore */
    }
  }

  layout(): void {
    if (!this.window || !this.activeId || this.settingsOpen) return;
    const tab = this.tabs.get(this.activeId);
    if (!tab) return;
    const { width, height } = this.window.getContentBounds();
    tab.view.setAutoResize({ width: false, height: false, horizontal: false, vertical: false });
    tab.view.setBounds({
      x: 0,
      y: this.chromeHeight,
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(height) - this.chromeHeight),
    });
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
      this.createTab(url, { record: false });
      return { action: "deny" };
    });
    wc.on("page-favicon-updated", (_e, icons) => {
      tab.favicon = icons[0] ?? null;
      this.onChange();
    });
    wc.on("page-title-updated", () => {
      if (!tab.incognito) this.history?.updateTitle(wc.getURL(), wc.getTitle());
      this.onChange();
    });
    wc.on("did-navigate", () => {
      if (this.activeId === tab.id) this.snapshotByRef.clear();
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
    wc.session.webRequest.onCompleted((details) => {
      if (details.resourceType === "mainFrame" && details.statusCode >= 400) {
        tab.networkFailures.push(`${details.statusCode} ${details.url}`.slice(0, 400));
        tab.networkFailures = tab.networkFailures.slice(-80);
      }
    });
    wc.session.webRequest.onErrorOccurred((details) => {
      if (details.resourceType === "mainFrame") {
        tab.networkFailures.push(`${details.error} ${details.url}`.slice(0, 400));
        tab.networkFailures = tab.networkFailures.slice(-80);
      }
    });
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

  private async playwrightPage(): Promise<PwPage | null> {
    await this.connectPlaywright();
    if (!this.pw) return null;
    const url = this.activeUrl();
    if (!url || url.startsWith("file:")) return null;
    const pages = this.pw.contexts().flatMap((ctx) => ctx.pages());
    return pages.find((p) => p.url() === url) || null;
  }

  private async withPage(pwFn: (page: PwPage) => Promise<void>, fallback: () => Promise<void>): Promise<void> {
    const page = await this.playwrightPage();
    if (page) {
      await pwFn(page);
      return;
    }
    await fallback();
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
