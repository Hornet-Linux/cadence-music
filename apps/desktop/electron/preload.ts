import { contextBridge, ipcRenderer } from "electron";
import type { AuthResponse } from "@uma/shared";

// The only surface the renderer (and, through it, plugins) can touch in the
// main process. Keep this intentionally small and explicit.
const api = {
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
  },
  /** OS-encrypted key/value storage for tokens. */
  secrets: {
    get: (key: string) => ipcRenderer.invoke("secrets:get", key) as Promise<string | null>,
    set: (key: string, value: string) => ipcRenderer.invoke("secrets:set", key, value) as Promise<void>,
    delete: (key: string) => ipcRenderer.invoke("secrets:delete", key) as Promise<void>,
  },
  auth: {
    /** Sign in through the system browser with the server's OIDC provider. */
    oidcLogin: (serverUrl: string) =>
      ipcRenderer.invoke("auth:oidc-login", serverUrl) as Promise<AuthResponse>,
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("host", api);

export type HostBridge = typeof api;
