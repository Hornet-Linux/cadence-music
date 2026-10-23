import { useServer } from "@/plugins/builtins/server/serverStore";
import type { Plugin, PluginContext } from "../../types";
import { desktopBridge, desktopOnly } from "../_desktop/desktop";
import { buildHeartbeat } from "./overlay";
import { ObsSettings } from "./ObsSettings";
import { obsSettings, useObsState } from "./store";

// Feeds the server what is playing so an OBS Browser Source overlay can show it.
// Desktop app only. The overlay itself is served by the server's "Now playing overlay" plugin.

const KEEPALIVE_MS = 15_000;

let ctxNow: PluginContext | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;
let teardown: (() => void) | null = null;
let lastBody = "";

async function send(force = false) {
  const ctx = ctxNow;
  const server = useServer.getState();
  if (!ctx || !server.user || !obsSettings.get().sendNowPlaying) return;
  const body = JSON.stringify(buildHeartbeat(ctx.player.getState()));
  // A repeated "stopped" tells the server nothing new.
  if (!force && body === lastBody && body.startsWith('{"state":"stopped"')) return;
  lastBody = body;
  try {
    await server.api("api/now-playing", { method: "POST", body });
    useObsState.setState({ sending: { tone: "ok", text: "Your server is receiving what you play" } });
  } catch {
    useObsState.setState({
      sending: { tone: "warn", text: "Could not reach the Now playing overlay on your server. Is the plugin turned on there?" },
    });
  }
}

function syncTimer() {
  const ctx = ctxNow;
  const playing = !!ctx && ctx.player.getState().isPlaying && obsSettings.get().sendNowPlaying;
  if (playing && !keepalive) keepalive = setInterval(() => void send(true), KEEPALIVE_MS);
  if (!playing && keepalive) {
    clearInterval(keepalive);
    keepalive = null;
  }
}

export const obsOverlayPlugin: Plugin = {
  manifest: {
    id: "cadence.obs-overlay",
    name: "OBS now-playing overlay",
    version: "1.0.0",
    description:
      "Show what you are playing in OBS with a see-through browser-source overlay served by your Cadence server (desktop app only). Needs the server's Now playing overlay plugin.",
    author: "Cadence",
    capabilities: ["player.read", "ui.settings", "storage", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    if (!desktopBridge()) return;
    ctxNow = ctx;
    obsSettings.bind(ctx.storage);
    ctx.registerSettingsPanel({
      id: "obs-overlay",
      title: "OBS overlay",
      description: "A now-playing overlay for OBS and streaming.",
      keywords: ["stream", "streaming", "browser source", "twitch", "youtube", "now playing"],
      render: () => <ObsSettings />,
    });
    ctx.onPlayback((event) => {
      if (event.kind === "progress") return;
      void send(true);
      syncTimer();
    });
    if (!teardown) {
      const offSettings = obsSettings.useSettings.subscribe((s, prev) => {
        if (s.values.sendNowPlaying === prev.values.sendNowPlaying) return;
        if (s.values.sendNowPlaying) void send(true);
        else if (useServer.getState().user) {
          // Turned off: hide the overlay right away instead of waiting for it to go stale.
          void useServer
            .getState()
            .api("api/now-playing", { method: "POST", body: JSON.stringify({ state: "stopped" }) })
            .catch(() => undefined);
        }
        syncTimer();
      });
      // Start sending once the person signs in to the server.
      const offServer = useServer.subscribe((s, prev) => {
        if (s.user && !prev.user) void send(true);
      });
      teardown = () => {
        offSettings();
        offServer();
        teardown = null;
      };
    }
    syncTimer();
    void send(true);
  },
  deactivate() {
    teardown?.();
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    // Tell the server nothing is playing so the overlay hides at once.
    const server = useServer.getState();
    if (server.user && obsSettings.get().sendNowPlaying) {
      void server.api("api/now-playing", { method: "POST", body: JSON.stringify({ state: "stopped" }) }).catch(() => undefined);
    }
    ctxNow = null;
    lastBody = "";
    useObsState.setState({ sending: null });
  },
};

export default desktopOnly([obsOverlayPlugin]);