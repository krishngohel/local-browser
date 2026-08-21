export type TabInfo = {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  favicon: string | null;
  incognito: boolean;
};

export type HistoryEntry = { url: string; title: string; visitedAt: string };

export type BookmarkInfo = { id: string; url: string; title: string; createdAt: string };

export type DownloadInfo = {
  id: string;
  filename: string;
  path: string;
  bytes: number;
  totalBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  startedAt: string;
};

export type TestRunInfo = {
  id: string | null;
  startedAt: string | null;
  assertions: number;
  failures: number;
  dir: string | null;
};

export type RecordedAction =
  | { type: "navigate"; url: string }
  | { type: "newTab"; url?: string }
  | { type: "selectTab"; url: string; title?: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "click"; selectors: string[]; text?: string }
  | { type: "hover"; selectors: string[] }
  | { type: "type"; selectors: string[]; text: string; submit?: boolean; name?: string }
  | { type: "press"; key: string }
  | { type: "scroll"; deltaY: number }
  | { type: "select"; selectors: string[]; value: string }
  | { type: "wait"; text?: string; ms?: number };

export type RecordingFile = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  actions: RecordedAction[];
};

export type RecordingInfo = {
  id: string;
  name: string;
  createdAt: string;
  actionCount: number;
};

export type RecordingState = {
  active: boolean;
  playing: boolean;
  name: string | null;
  actionCount: number;
  recordings: RecordingInfo[];
};

export type TransferPrefs = {
  snapshotPhoto: boolean;
  screenshotPhoto: boolean;
  watchFrames: boolean;
  readableText: boolean;
  skillTreeOnConnect: boolean;
  toolsBrowse: boolean;
  toolsSee: boolean;
  toolsSearch: boolean;
  toolsDebug: boolean;
  toolsTest: boolean;
  toolsRecord: boolean;
  toolsRead: boolean;
  toolsInteract: boolean;
  toolsState: boolean;
  toolsQa: boolean;
};

export type AppSettings = {
  theme: "system" | "light" | "dark";
  compactChrome: boolean;
  homeUrl: string;
  evaluateEnabled: boolean;
};

export type ActivityEntry = {
  id: number;
  tool: string;
  client: string;
  startedAt: string;
  ms: number;
  ok: boolean;
  summary: string;
};

export type ActivityState = {
  paused: boolean;
  count: number;
  running: string | null;
  recent: ActivityEntry[];
};

export type AppState = {
  tabs: TabInfo[];
  activeTabId: string | null;
  mcp: {
    listening: boolean;
    url: string;
    lanUrl: string | null;
    lanUrls: string[];
    port: number;
  };
  connect: {
    cursorConfigExists: boolean;
    cursorRegistered: boolean;
    cursorLive: boolean;
    claudeConfigExists: boolean;
    claudeRegistered: boolean;
    claudeLive: boolean;
    chatgptConfigExists: boolean;
    chatgptRegistered: boolean;
    chatgptLive: boolean;
    otherLive: number;
    otherNames: string[];
    liveCount: number;
  };
  test: TestRunInfo;
  recording: RecordingState;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  banner: string;
  version: string;
  transfer: TransferPrefs;
  platform: string;
  toolCount: number;
  activity: ActivityState;
  settings: AppSettings;
  bookmarks: { count: number; activeBookmarked: boolean };
};

export type ConnectResult = {
  ok: boolean;
  message: string;
  path?: string;
  paths?: string[];
};

export type PlayResult = {
  ok: boolean;
  message: string;
};

export type ConnectSnippets = {
  localUrl: string;
  lanUrl: string | null;
  lanUrls: string[];
  token: string;
  httpJson: string;
  httpLanJson: string | null;
  stdioJson: string;
  stdioLanJson: string | null;
  vscodeJson: string;
  vscodeLanJson: string | null;
};
