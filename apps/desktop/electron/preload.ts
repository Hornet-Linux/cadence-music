import { contextBridge, ipcRenderer, webFrame } from "electron";
import type { AuthResponse } from "@uma/shared";
import type { DiscordStatus, PresenceActivity } from "./discordIpc";
import type { ControlInfo, ControlRequest, ShortcutResult } from "./integrations";
import type { SlackResult, SlackStatusInput } from "./slack";
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
  /** Interface size: the page zoom factor (1 = 100%). */
  ui: {
    setZoom: (factor: number) => webFrame.setZoomFactor(Math.min(3, Math.max(0.5, factor))),
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
  /**
   * Desktop-only integrations used by the Discord, Media keys, Control API and Status plugins.
   * Each call is validated again in the main process, and the main process ignores
   * anything that does not come from the app's own window.
   */
  integrations: {
    discord: {
      start: (applicationId: string) => ipcRenderer.invoke("discord:start", applicationId) as Promise<DiscordStatus>,
      setActivity: (activity: PresenceActivity | null) => ipcRenderer.invoke("discord:activity", activity) as Promise<void>,
      stop: () => ipcRenderer.invoke("discord:stop") as Promise<void>,
      status: () => ipcRenderer.invoke("discord:status") as Promise<DiscordStatus>,
      onStatus: (cb: (status: DiscordStatus) => void) => {
        const listener = (_e: unknown, status: DiscordStatus) => cb(status);
        ipcRenderer.on("discord:status", listener);
        return () => void ipcRenderer.off("discord:status", listener);
      },
    },
    shortcuts: {
      /** Replace every global shortcut. Resolves with one result per binding. */
      set: (bindings: { id: string; accelerator: string }[]) =>
        ipcRenderer.invoke("shortcuts:set", bindings) as Promise<ShortcutResult[]>,
      clear: () => ipcRenderer.invoke("shortcuts:clear") as Promise<void>,
      onTriggered: (cb: (id: string) => void) => {
        const listener = (_e: unknown, id: unknown) => {
          if (typeof id === "string") cb(id);
        };
        ipcRenderer.on("shortcuts:triggered", listener);
        return () => void ipcRenderer.off("shortcuts:triggered", listener);
      },
    },
    system: {
      mediaControls: () => ipcRenderer.invoke("system:media-controls") as Promise<boolean>,
      setMediaControls: (on: boolean) =>
        ipcRenderer.invoke("system:set-media-controls", on) as Promise<{ restartRequired: boolean }>,
      relaunch: () => ipcRenderer.invoke("system:relaunch") as Promise<void>,
    },
    control: {
      start: (port: number) => ipcRenderer.invoke("control:start", port) as Promise<ControlInfo>,
      stop: () => ipcRenderer.invoke("control:stop") as Promise<void>,
      status: () => ipcRenderer.invoke("control:status") as Promise<ControlInfo>,
      regenerateToken: () => ipcRenderer.invoke("control:regenerate-token") as Promise<ControlInfo>,
      /** Share the now-playing snapshot and the runnable command names with the API. */
      pushState: (state: unknown, commands: string[]) => ipcRenderer.send("control:state", state, commands),
      /** Handle a command from the API. Resolve with a result or reject with a short error. */
      setHandler: (handler: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null) => {
        ipcRenderer.removeAllListeners("control:command");
        if (!handler) return;
        ipcRenderer.on("control:command", (_e, req: ControlRequest) => {
          handler(req.name, req.args).then(
            (result) => ipcRenderer.send("control:result", { id: req.id, ok: true, result }),
            (err: unknown) =>
              ipcRenderer.send("control:result", { id: req.id, ok: false, error: err instanceof Error ? err.message : "failed" }),
          );
        });
      },
    },
    slack: {
      test: () => ipcRenderer.invoke("slack:test") as Promise<SlackResult>,
      setStatus: (status: SlackStatusInput) => ipcRenderer.invoke("slack:set", status) as Promise<SlackResult>,
      clearStatus: () => ipcRenderer.invoke("slack:clear") as Promise<SlackResult>,
      /** Clear the status and delete the saved token. */
      forget: () => ipcRenderer.invoke("slack:forget") as Promise<void>,
    },
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("host", api);

export type HostBridge = typeof api;
