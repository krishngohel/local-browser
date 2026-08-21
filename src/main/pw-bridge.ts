export type PwBoundingBox = { x: number; y: number; width: number; height: number };

export type PwLocator = {
  click: (opts?: { timeout?: number; button?: "left" | "right" | "middle" }) => Promise<void>;
  dblclick: (opts?: { timeout?: number }) => Promise<void>;
  hover: (opts?: { timeout?: number }) => Promise<void>;
  fill: (value: string) => Promise<void>;
  press: (key: string) => Promise<void>;
  selectOption: (value: string) => Promise<void>;
  dragTo: (target: PwLocator, opts?: { timeout?: number }) => Promise<void>;
  boundingBox: (opts?: { timeout?: number }) => Promise<PwBoundingBox | null>;
  setInputFiles: (files: string[], opts?: { timeout?: number }) => Promise<void>;
  first: () => PwLocator;
};

/** Anything locators can be built from — a page, or one of its frames. */
export type PwLocatorRoot = {
  url: () => string;
  locator: (selector: string) => PwLocator;
};

export type PwFrame = PwLocatorRoot & {
  name: () => string;
};

export type PwDialog = {
  type: () => string;
  message: () => string;
  defaultValue?: () => string;
  accept: (promptText?: string) => Promise<void>;
  dismiss: () => Promise<void>;
};

export type PwMouse = {
  move: (x: number, y: number, opts?: { steps?: number }) => Promise<void>;
  down: (opts?: { button?: "left" | "right" | "middle" }) => Promise<void>;
  up: (opts?: { button?: "left" | "right" | "middle" }) => Promise<void>;
};

export type PwPage = PwLocatorRoot & {
  frames: () => PwFrame[];
  mouse: PwMouse;
  on: (event: "dialog", listener: (dialog: PwDialog) => void) => void;
  getByText: (text: string, opts?: { exact?: boolean }) => PwLocator;
  getByRole: (role: string, opts?: { name?: string; exact?: boolean }) => PwLocator;
  getByPlaceholder: (text: string) => PwLocator;
  getByLabel: (text: string) => PwLocator;
  keyboard: { press: (key: string) => Promise<void> };
  screenshot: (opts?: {
    type?: "png" | "jpeg";
    quality?: number;
    fullPage?: boolean;
    timeout?: number;
  }) => Promise<Buffer>;
  context: () => {
    tracing: {
      start: (opts: { screenshots?: boolean; snapshots?: boolean }) => Promise<void>;
      stop: (opts: { path: string }) => Promise<void>;
    };
    newCDPSession: (page: PwPage) => Promise<PwCdpSession>;
  };
};

export type PwCdpSession = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, listener: (params: ScreencastFrame) => void) => void;
  off?: (event: string, listener: (params: ScreencastFrame) => void) => void;
  detach: () => Promise<void>;
};

export type ScreencastFrame = {
  data: string;
  sessionId: number;
  metadata?: { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
};

export type PwBrowser = {
  contexts: () => { pages: () => PwPage[] }[];
};

type PlaywrightModule = {
  chromium: { connectOverCDP: (endpoint: string) => Promise<PwBrowser> };
};

export const pwBridge = {
  async connectOverCdp(endpoint: string): Promise<PwBrowser> {
    const { chromium } = require("playwright-core") as PlaywrightModule;
    return chromium.connectOverCDP(endpoint);
  },
};
