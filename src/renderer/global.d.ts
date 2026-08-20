import type { AppState, ConnectResult, ConnectSnippets, PlayResult, RecordingFile, RecordingState, TransferPrefs } from "../shared/types";

declare global {
  interface Window {
    lb: {
      getState: () => Promise<AppState>;
      navigate: (url: string) => Promise<void>;
      back: () => Promise<void>;
      forward: () => Promise<void>;
      reload: () => Promise<void>;
      newTab: () => Promise<void>;
      selectTab: (id: string) => Promise<void>;
      closeTab: (id: string) => Promise<void>;
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
      openMenu: () => Promise<void>;
      onState: (cb: (state: AppState) => void) => () => void;
      onOpenSettings: (cb: (section?: string) => void) => void;
      onFocusOmnibox: (cb: () => void) => void;
      onCloseSettings: (cb: () => void) => void;
    };
  }
}

export {};
