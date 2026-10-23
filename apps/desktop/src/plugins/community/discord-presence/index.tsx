import type { Plugin, PluginContext, PlaybackEvent } from "../../types";
import { desktopBridge, desktopOnly } from "../_desktop/desktop";
import { DiscordSettings } from "./DiscordSettings";
import { buildPresence, isApplicationId } from "./presence";
import { presenceSettings, useDiscordStatus } from "./store";

// Discord Rich Presence: shows the current track on your Discord profile.
// Desktop app only. The connection is made by the app's main process.

let ctxNow: PluginContext | null = null;
let teardown: (() => void) | null = null;

function pushPresence() {
  const bridge = desktopBridge();
  if (!bridge || !ctxNow) return;
  const settings = presenceSettings.get();
  if (!isApplicationId(settings.applicationId)) return;
  const s = ctxNow.player.getState();
  const activity = buildPresence(s.current, s, settings, Date.now());
  void bridge.discord.setActivity(activity).catch(() => undefined);
}

function applyConnection() {
  const bridge = desktopBridge();
  if (!bridge) return;
  const settings = presenceSettings.get();
  if (isApplicationId(settings.applicationId)) {
    void bridge.discord
      .start(settings.applicationId.trim())
      .then((s) => useDiscordStatus.getState().set(s))
      .catch((err: Error) => useDiscordStatus.getState().set({ state: "off", error: err.message }));
    pushPresence();
  } else {
    void bridge.discord.stop().catch(() => undefined);
    useDiscordStatus.getState().set({ state: "off" });
  }
}

function wire() {
  const bridge = desktopBridge();
  if (!bridge || teardown) return;
  const offStatus = bridge.discord.onStatus((s) => useDiscordStatus.getState().set(s));
  let lastId = presenceSettings.get().applicationId;
  const offSettings = presenceSettings.useSettings.subscribe((state, prev) => {
    if (state.values === prev.values) return;
    if (state.values.applicationId !== lastId) {
      lastId = state.values.applicationId;
      applyConnection();
    } else {
      pushPresence();
    }
  });
  teardown = () => {
    offStatus();
    offSettings();
    teardown = null;
  };
}

export const discordPresencePlugin: Plugin = {
  manifest: {
    id: "cadence.discord-presence",
    name: "Discord Rich Presence",
    version: "1.0.0",
    description: "Show what you are listening to on your Discord profile (desktop app only).",
    author: "Cadence",
    capabilities: ["player.read", "ui.settings", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    if (!desktopBridge()) return;
    ctxNow = ctx;
    presenceSettings.bind(ctx.storage);
    wire();
    ctx.registerSettingsPanel({
      id: "discord-presence",
      title: "Discord",
      description: "Rich Presence: show your current song on Discord.",
      keywords: ["rich presence", "listening", "status", "activity", "friends"],
      render: () => <DiscordSettings />,
    });
    ctx.onPlayback((event: PlaybackEvent) => {
      // Progress ticks carry nothing new: the clock is absolute.
      if (event.kind !== "progress") pushPresence();
    });
    applyConnection();
  },
  deactivate() {
    teardown?.();
    ctxNow = null;
    const bridge = desktopBridge();
    void bridge?.discord.stop().catch(() => undefined);
    useDiscordStatus.getState().set({ state: "off" });
  },
};

export default desktopOnly([discordPresencePlugin]);