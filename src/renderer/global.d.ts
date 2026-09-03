import type { AppSettings, AppState, BookmarkInfo, CaptchaSolverPublic, ConnectResult, ConnectSnippets, GridFrame, HistoryEntry, PlayResult, Profile, RecordingFile, RecordingState, TransferPrefs } from "../shared/types";
import type { ToolManifestEntry } from "../shared/tool-manifest";

declare global {
  interface Window {
    lb: {
      getState: () => Promise<AppState>;
      navigate: (url: string) => Promise<void>;
      back: () => Promise<void>;
      forward: () => Promise<void>;
      reload: () => Promise<void>;
      stop: () => Promise<void>;
      newTab: () => Promise<void>;
      selectTab: (id: string) => Promise<void>;
      closeTab: (id: string) => Promise<void>;
      newIncognitoTab: () => Promise<void>;
      reorderTab: (id: string, index: number) => Promise<void>;
      tabThumbnail: (id: string) => Promise<string>;
      setChromeHeight: (px: number) => Promise<void>;
      setOverlay: (px: number) => Promise<void>;
      addBookmark: () => Promise<BookmarkInfo | null>;
      removeBookmark: (idOrUrl: string) => Promise<boolean>;
      listBookmarks: () => Promise<BookmarkInfo[]>;
      searchHistory: (q: string) => Promise<HistoryEntry[]>;
      search: (query: string) => Promise<void>;
      connectCursor: () => Promise<ConnectResult>;
      connectClaude: () => Promise<ConnectResult>;
      revealClaudeConfig: () => Promise<string>;
      connectChatGpt: () => Promise<ConnectResult>;
      connectSnippets: () => Promise<ConnectSnippets>;
      copyText: (text: string) => Promise<void>;
      testStart: () => Promise<string>;
      testEnd: () => Promise<string>;
      recordToggle: () => Promise<RecordingState>;
      recordStart: (name?: string) => Promise<RecordingState>;
      recordStop: () => Promise<RecordingFile | null>;
      recordingPlay: (id: string) => Promise<PlayResult>;
      recordingDelete: (id: string) => Promise<void>;
      recordingRename: (id: string, name: string) => Promise<void>;
      openUserData: () => Promise<void>;
      getAutostart: () => Promise<boolean>;
      setAutostart: (enabled: boolean) => Promise<boolean>;
      setTransfer: (next: Partial<TransferPrefs>) => Promise<TransferPrefs>;
      setSettings: (open: boolean) => Promise<void>;
      getSettings: () => Promise<AppSettings>;
      updateSettings: (next: Partial<AppSettings>) => Promise<AppSettings>;
      getCaptchaSolver: () => Promise<CaptchaSolverPublic>;
      updateCaptchaSolver: (next: {
        enabled?: boolean;
        provider?: "agent" | "openai" | "gemini";
        openaiKey?: string;
        geminiKey?: string;
        openaiModel?: string;
        geminiModel?: string;
      }) => Promise<CaptchaSolverPublic>;
      getProfile: () => Promise<Profile>;
      updateProfile: (next: Partial<Profile>) => Promise<Profile>;
      applyUpdate: () => Promise<void>;
      viewUpdateRelease: () => Promise<void>;
      toolManifest: () => Promise<ToolManifestEntry[]>;
      setPaused: (p: boolean) => Promise<boolean>;
      clearActivity: () => Promise<void>;
      openMenu: () => Promise<void>;
      onState: (cb: (state: AppState) => void) => () => void;
      onOpenSettings: (cb: (section?: string) => void) => void;
      onFocusOmnibox: (cb: () => void) => void;
      onCloseSettings: (cb: () => void) => void;
      onCloseOverlays: (cb: () => void) => void;
      onToggleBookmark: (cb: () => void) => void;
      onOpenPalette: (cb: () => void) => void;
      onGridFrame: (cb: (frame: GridFrame) => void) => () => void;
    };
  }
}

export {};
