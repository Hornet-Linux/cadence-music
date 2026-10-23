import { contextBridge, ipcRenderer } from "electron";
import type { AuthResponse } from "@uma/shared";
import type { LlmJsonRequest, LlmStatus } from "./llm";
import type { LocalLlmConfig } from "./llmKeys";
import type { SpotifyAccessToken, SpotifyStatus } from "./spotify";

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
  /** Spotify sign-in; refresh tokens never leave the main process. */
  spotify: {
    status: () => ipcRenderer.invoke("spotify:status") as Promise<SpotifyStatus>,
    login: (clientId: string) => ipcRenderer.invoke("spotify:login", clientId) as Promise<SpotifyStatus>,
    /** A short-lived access token, refreshed as needed; null when signed out. */
    token: () => ipcRenderer.invoke("spotify:token") as Promise<SpotifyAccessToken | null>,
    logout: () => ipcRenderer.invoke("spotify:logout") as Promise<void>,
  },
  /**
   * LLM calls for the AI DJ, made from the main process. A saved provider is
   * named by `providerId`; its key is attached here and only sent to the
   * address it was saved for.
   */
  llm: {
    status: (config: LocalLlmConfig) => ipcRenderer.invoke("llm:status", config) as Promise<LlmStatus>,
    chatJson: <T = unknown>(config: LocalLlmConfig, req: LlmJsonRequest) =>
      ipcRenderer.invoke("llm:chat-json", config, req) as Promise<T>,
    /** Save (or with null, remove) a provider's API key, bound to `baseUrl`'s origin. */
    saveKey: (providerId: string, baseUrl: string, key: string | null) =>
      ipcRenderer.invoke("llm:save-key", providerId, baseUrl, key) as Promise<void>,
    hasKey: (providerId: string) => ipcRenderer.invoke("llm:has-key", providerId) as Promise<boolean>,
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("host", api);

export type HostBridge = typeof api;
