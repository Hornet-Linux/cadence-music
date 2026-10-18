import { contextBridge, ipcRenderer } from "electron";

// The only surface the renderer (and, through it, plugins) can touch in the
// main process. Keep this intentionally small and explicit.
const api = {
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("host", api);

export type HostBridge = typeof api;
