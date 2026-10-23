import { useCollection } from "@/features/collection/collectionStore";
import { usePluginHost } from "../../host";
import type { Plugin, PluginContext } from "../../types";
import { desktopBridge, desktopOnly } from "../_desktop/desktop";
import { liveTransport } from "../_desktop/liveTransport";
import { ControlApiSettings } from "./ControlApiSettings";
import { startMidi } from "./midiController";
import { buildState, createRouter, type CommandRouter } from "./router";
import { controlSettings, useControlInfo, useMidiState } from "./store";

// A local, token-protected control API for Stream Deck, scripts and MIDI gear
// (desktop app only). The HTTP/WebSocket server lives in the main process, bound to
// 127.0.0.1; this plugin answers its commands and keeps its now-playing snapshot fresh.

let ctxNow: PluginContext | null = null;
let router: CommandRouter | null = null;
let teardown: (() => void) | null = null;
let stopMidi: (() => void) | null = null;
let midiStarting = false;

const registry = () => usePluginHost.getState().contributions.commands;

function pushState() {
  const bridge = desktopBridge();
  if (!bridge || !ctxNow || !router) return;
  const s = ctxNow.player.getState();
  const liked = !!s.current && useCollection.getState().likes.some((l) => l.track.id === s.current?.id);
  bridge.control.pushState(buildState(s, liked), router.names());
}

function runCommand(name: string, args: Record<string, unknown>) {
  void router?.run(name, args).catch(() => undefined);
}

function syncMidi() {
  const wanted = controlSettings.get().midiEnabled;
  if (!wanted) {
    stopMidi?.();
    stopMidi = null;
    useMidiState.setState({ error: null, learning: null, lastSeen: null });
    return;
  }
  if (stopMidi || midiStarting) return;
  midiStarting = true;
  void startMidi({
    getMappings: () => controlSettings.get().mappings,
    setMappings: (mappings) => controlSettings.set({ mappings }),
    getLearning: () => useMidiState.getState().learning,
    finishLearning: () => useMidiState.setState({ learning: null }),
    run: runCommand,
    onInputs: (inputs) => useMidiState.setState({ inputs }),
    onSeen: (lastSeen) => useMidiState.setState({ lastSeen }),
  })
    .then((stop) => {
      if (controlSettings.get().midiEnabled) {
        stopMidi = stop;
        useMidiState.setState({ error: null });
      } else stop();
    })
    .catch((err: Error) => useMidiState.setState({ error: err.message || "Could not open MIDI" }))
    .finally(() => {
      midiStarting = false;
    });
}

async function startServer() {
  const bridge = desktopBridge();
  if (!bridge) return;
  try {
    useControlInfo.getState().set(await bridge.control.start(controlSettings.get().port));
  } catch (err) {
    useControlInfo.getState().set({ running: false, port: null, clients: 0, token: null, error: (err as Error).message });
  }
}

function wire() {
  if (teardown) return;
  const offSettings = controlSettings.useSettings.subscribe((s, prev) => {
    if (s.values.midiEnabled !== prev.values.midiEnabled) syncMidi();
    if (s.values.allowOthers !== prev.values.allowOthers) pushState();
  });
  const offLikes = useCollection.subscribe((s, prev) => {
    if (s.likes !== prev.likes) pushState();
  });
  teardown = () => {
    offSettings();
    offLikes();
    teardown = null;
  };
}

export const controlApiPlugin: Plugin = {
  manifest: {
    id: "cadence.control-api",
    name: "Control API (Stream Deck, scripts, MIDI)",
    version: "1.0.0",
    description:
      "A local, password-protected HTTP and WebSocket API plus Web MIDI mapping so Stream Deck, scripts and MIDI controllers can control playback (desktop app only).",
    author: "Cadence",
    capabilities: ["player.read", "player.control", "ui.settings", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const bridge = desktopBridge();
    if (!bridge) return;
    ctxNow = ctx;
    controlSettings.bind(ctx.storage);
    router = createRouter({
      actions: liveTransport(ctx.player),
      registry,
      allowOthers: () => controlSettings.get().allowOthers,
    });
    const active = router;
    bridge.control.setHandler((name, args) => active.run(name, args));

    ctx.registerSettingsPanel({
      id: "control-api",
      title: "Control API",
      description: "Stream Deck, scripts and MIDI controllers.",
      keywords: ["stream deck", "http", "websocket", "midi", "remote", "automation", "token"],
      render: () => <ControlApiSettings names={() => active.names()} />,
    });

    let ticks = 0;
    ctx.onPlayback((event) => {
      // Position is rounded to seconds; every fifth tick is plenty for a display.
      if (event.kind !== "progress" || ++ticks % 5 === 0) pushState();
    });

    wire();
    syncMidi();
    void startServer().then(pushState);
  },
  deactivate() {
    teardown?.();
    stopMidi?.();
    stopMidi = null;
    const bridge = desktopBridge();
    bridge?.control.setHandler(null);
    void bridge?.control.stop().catch(() => undefined);
    useControlInfo.getState().set(null);
    ctxNow = null;
    router = null;
  },
};

export default desktopOnly([controlApiPlugin]);