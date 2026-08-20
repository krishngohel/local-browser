import { contextBridge, ipcRenderer } from "electron";
import type { AppState, ConnectResult, ConnectSnippets, PlayResult, RecordingFile, RecordingState, TransferPrefs } from "../shared/types";

contextBridge.exposeInMainWorld("lb", {
  getState: (): Promise<AppState> => ipcRenderer.invoke("state"),
  navigate: (url: string) => ipcRenderer.invoke("navigate", url),
  back: () => ipcRenderer.invoke("back"),
  forward: () => ipcRenderer.invoke("forward"),
  reload: () => ipcRenderer.invoke("reload"),
  newTab: () => ipcRenderer.invoke("tabs:new"),
  selectTab: (id: string) => ipcRenderer.invoke("tabs:select", id),
  closeTab: (id: string) => ipcRenderer.invoke("tabs:close", id),
  search: (query: string) => ipcRenderer.invoke("search", query),
  connectCursor: (): Promise<ConnectResult> => ipcRenderer.invoke("connect:cursor"),
  connectClaude: (): Promise<ConnectResult> => ipcRenderer.invoke("connect:claude"),
  revealClaudeConfig: (): Promise<string> => ipcRenderer.invoke("connect:reveal-claude-config"),
  connectChatGpt: (): Promise<ConnectResult> => ipcRenderer.invoke("connect:chatgpt"),
  connectSnippets: (): Promise<ConnectSnippets> => ipcRenderer.invoke("connect:snippets"),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:write", text),
  testStart: (): Promise<string> => ipcRenderer.invoke("test:start"),
  testEnd: (): Promise<string> => ipcRenderer.invoke("test:end"),
  recordToggle: (): Promise<RecordingState> => ipcRenderer.invoke("record:toggle"),
  recordStart: (name?: string): Promise<RecordingState> => ipcRenderer.invoke("record:start", name),
  recordStop: (): Promise<RecordingFile | null> => ipcRenderer.invoke("record:stop"),
  recordingPlay: (id: string): Promise<PlayResult> => ipcRenderer.invoke("recordings:play", id),
  recordingDelete: (id: string) => ipcRenderer.invoke("recordings:delete", id),
  recordingRename: (id: string, name: string) => ipcRenderer.invoke("recordings:rename", id, name),
  openUserData: () => ipcRenderer.invoke("open-user-data"),
  getAutostart: (): Promise<boolean> => ipcRenderer.invoke("autostart:get"),
  setAutostart: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke("autostart:set", enabled),
  setTransfer: (next: Partial<TransferPrefs>): Promise<TransferPrefs> => ipcRenderer.invoke("transfer:set", next),
  setSettings: (open: boolean) => ipcRenderer.invoke("settings:set", open),
  openMenu: () => ipcRenderer.invoke("menu:app"),
  onState: (cb: (state: AppState) => void) => {
    const listener = (_event: unknown, state: AppState) => cb(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  onOpenSettings: (cb: (section?: string) => void) => {
    ipcRenderer.on("open-settings", (_event, section?: string) => cb(section));
  },
  onFocusOmnibox: (cb: () => void) => {
    ipcRenderer.on("focus-omnibox", cb);
  },
  onCloseSettings: (cb: () => void) => {
    ipcRenderer.on("close-settings", cb);
  },
});
