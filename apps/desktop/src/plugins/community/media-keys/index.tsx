import { usePluginHost } from "../../host";
import type { Plugin, PluginContext } from "../../types";
import { desktopBridge, desktopOnly, hostPlatform } from "../_desktop/desktop";
import { liveTransport } from "../_desktop/liveTransport";
import { OWN_COMMANDS, OWN_PREFIX, effectiveBindings, planRegistration, positionState } from "./bindings";
import { MediaKeysSettings } from "./MediaKeysSettings";
import { mediaKeysSettings, useShortcutState } from "./store";

// System media controls and global shortcuts (desktop app only).
// The OS media overlay itself is fed by the player's own Media Session; this plugin
// adds seeking and the timeline to it, switches on the system integration, and
// registers global shortcuts for the host's commands.

let teardown: (() => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

async function syncShortcuts() {
  const bridge = desktopBridge();
  if (!bridge) return;
  const commands = usePluginHost.getState().contributions.commands;
  const bindings = effectiveBindings(commands, mediaKeysSettings.get());
  const plan = planRegistration(bindings, hostPlatform());
  let results: Record<string, { ok: boolean; error?: string }> = {};
  try {
    const list = await bridge.shortcuts.set(plan.send);
    results = Object.fromEntries(list.map((r) => [r.id, { ok: r.ok, error: r.error }]));
  } catch {
    results = Object.fromEntries(plan.send.map((b) => [b.id, { ok: false, error: "Could not register shortcuts" }]));
  }
  useShortcutState.setState({ bindings, plan, results });
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncShortcuts();
  }, 150);
}

function wire() {
  const bridge = desktopBridge();
  if (!bridge || teardown) return;
  const offTriggered = bridge.shortcuts.onTriggered((id) => {
    const command = usePluginHost.getState().contributions.commands.find((c) => c.id === id);
    if (command) void Promise.resolve(command.run()).catch(() => undefined);
  });
  const offSettings = mediaKeysSettings.useSettings.subscribe((s, prev) => {
    if (s.values !== prev.values) scheduleSync();
  });
  const offCommands = usePluginHost.subscribe((s, prev) => {
    if (s.contributions.commands !== prev.contributions.commands) scheduleSync();
  });
  teardown = () => {
    offTriggered();
    offSettings();
    offCommands();
    teardown = null;
  };
}

/** Seeking and the timeline in the system overlay. */
function wireMediaSession(ctx: PluginContext) {
  const session = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
  if (!session) return;
  const skip = (delta: number) => {
    const s = ctx.player.getState();
    if (s.current) ctx.player.seek(Math.max(0, Math.min(s.duration || Infinity, s.position + delta)));
  };
  try {
    session.setActionHandler("seekbackward", (d) => skip(-(d.seekOffset ?? 10)));
    session.setActionHandler("seekforward", (d) => skip(d.seekOffset ?? 10));
  } catch {
    // This browser build lacks those actions; the rest still works.
  }
  const update = () => {
    const s = ctx.player.getState();
    const state = s.current ? positionState(s.duration, s.position, s.isPlaying) : null;
    try {
      if (state) session.setPositionState(state);
      else session.setPositionState();
    } catch {
      // Invalid state for this moment (for example a stream with no duration).
    }
  };
  ctx.onPlayback((event) => {
    if (event.kind !== "progress" || Math.round(event.position) % 5 === 0) update();
  });
}

export const mediaKeysPlugin: Plugin = {
  manifest: {
    id: "cadence.media-keys",
    name: "Media keys and shortcuts",
    version: "1.0.0",
    description:
      "System media controls (Windows media overlay, macOS Now Playing, Linux MPRIS) and global keyboard shortcuts you can change (desktop app only).",
    author: "Cadence",
    capabilities: ["player.read", "player.control", "commands", "ui.settings", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const bridge = desktopBridge();
    if (!bridge) return;
    mediaKeysSettings.bind(ctx.storage);

    const actions = liveTransport(ctx.player);
    for (const c of OWN_COMMANDS) {
      const action = actions[c.name]!;
      ctx.registerCommand({
        id: `${OWN_PREFIX}${c.name}`,
        title: c.title,
        keywords: ["media", "key", "shortcut", c.name.replace("-", " ")],
        shortcut: c.shortcut,
        run: () => void action.run({}),
      });
    }
    ctx.registerSettingsPanel({
      id: "media-keys",
      title: "Media keys",
      description: "System media controls and global shortcuts.",
      keywords: ["hotkey", "keyboard", "global", "smtc", "mpris", "now playing", "headset"],
      render: () => <MediaKeysSettings />,
    });
    wireMediaSession(ctx);
    wire();
    void bridge.system
      .mediaControls()
      .then((on) => useShortcutState.setState({ systemControls: on }))
      .catch(() => undefined);
    // The commands list is rebuilt around this activation; register once it has settled.
    scheduleSync();
  },
  deactivate() {
    teardown?.();
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    void desktopBridge()
      ?.shortcuts.clear()
      .catch(() => undefined);
    useShortcutState.setState({ bindings: [], plan: null, results: {} });
    try {
      navigator.mediaSession?.setActionHandler("seekbackward", null);
      navigator.mediaSession?.setActionHandler("seekforward", null);
    } catch {
      // Nothing to undo.
    }
  },
};

export default desktopOnly([mediaKeysPlugin]);