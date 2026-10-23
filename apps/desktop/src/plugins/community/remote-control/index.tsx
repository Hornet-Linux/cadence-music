import { isWeb } from "@/platform/webHost";
import { useServer } from "../../builtins/server/serverStore";
import type { Plugin, PluginContext } from "../../types";
import { executeCommand } from "./execute";
import { RemoteLink } from "./remoteLink";
import { RemotePage } from "./RemotePage";
import { loadDeviceName, renewDeviceId, useRemote } from "./remoteStore";
import { startReporter, type Reporter } from "./reporter";
import { createRemoteTarget } from "./target";

// The connection outlives a single activation: the host re-runs activate whenever any plugin is toggled.
let link: RemoteLink | null = null;
let reporter: Reporter | null = null;
let current: PluginContext | null = null;
let listenersAttached = false;

function auth() {
  const s = useServer.getState();
  return s.url && s.token && s.user ? { url: s.url.replace(/\/+$/, ""), token: s.token } : null;
}

function kind(): string {
  if (typeof navigator !== "undefined" && /android|iphone|ipad/i.test(navigator.userAgent)) return "phone";
  return isWeb() ? "web" : "desktop";
}

function ensureLink(): RemoteLink {
  if (link) return link;
  link = new RemoteLink({
    getAuth: auth,
    getDeviceId: () => useRemote.getState().deviceId,
    renewDeviceId,
    getName: () => useRemote.getState().deviceName,
    kind: kind(),
    onStatus: (status) => {
      useRemote.setState({ status });
      if (status === "online") reporter?.sendNow();
    },
    onDevices: (devices) => useRemote.getState().setDevices(devices),
    onDeviceState: (device) => useRemote.getState().upsertDevice(device),
    onCommand: (command) => {
      if (current) void executeCommand(current.player, command).catch(() => undefined);
    },
  });
  return link;
}

function attachBrowserListeners() {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  // Phones suspend background pages; come back quickly when the page returns or the network does.
  window.addEventListener("online", () => link?.nudge());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && useRemote.getState().status !== "online") link?.nudge();
  });
}

function RemoteIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <circle cx="12" cy="9" r="2" />
      <path d="M10 15h4M10 18h4" />
    </svg>
  );
}

/** Control another Cadence player of yours (computer from phone and back), through your server. */
const remoteControl: Plugin = {
  manifest: {
    id: "cadence.remote-control",
    name: "Remote control",
    version: "1.0.0",
    description:
      "Each open Cadence player registers with your server so you can control it from another device: play, pause, skip, seek, volume and queue. Needs the Remote control server plugin turned on by your server admin.",
    author: "Cadence",
    capabilities: ["player.read", "player.control", "player.queue", "output.device", "ui.sidebar", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    current = ctx;
    reporter?.stop();
    reporter = startReporter(
      ctx,
      (state) => useServer.getState().api("api/remote-control/state", { method: "POST", body: JSON.stringify({ deviceId: useRemote.getState().deviceId, state }) }),
      () => useRemote.getState().status === "online",
    );
    useRemote.setState({ deviceName: loadDeviceName() });
    ctx.registerSidebarItem({ id: "remote-control", label: "Remote", icon: <RemoteIcon />, render: () => <RemotePage /> });
    ctx.registerOutputTarget(createRemoteTarget(ctx));
    attachBrowserListeners();
    ensureLink().start();
  },
  deactivate() {
    link?.stop();
    reporter?.stop();
    reporter = null;
    current = null;
    useRemote.setState({ devices: [], selectedId: null });
  },
};

export default remoteControl;
