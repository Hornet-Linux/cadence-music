import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { emptyContributions, setPlayerApi, usePluginHost } from "../../host";
import type { Plugin, PlayerApi } from "../../types";

// Every test re-imports the real plugin modules (and their whole React/zustand graph) from scratch, because
// the desktop-only gate is decided when each module loads. That is quick on an idle machine but takes
// several seconds when all cores are busy, so the default 5 s limit made these tests fail under load.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ids = ["discord-presence", "media-keys", "obs-overlay", "control-api", "status-sync"] as const;
const manifestIds = [
  "cadence.discord-presence",
  "cadence.media-keys",
  "cadence.obs-overlay",
  "cadence.control-api",
  "cadence.status-sync",
];

const track: Track = { id: "t1", title: "Song", artists: [{ id: "a", name: "Artist" }], album: "Album", durationSec: 200 };

function fakeBridge() {
  return {
    discord: {
      start: vi.fn(async () => ({ state: "connecting" as const })),
      setActivity: vi.fn(async (...args: [unknown]) => void args),
      stop: vi.fn(async () => undefined),
      status: vi.fn(async () => ({ state: "off" as const })),
      onStatus: vi.fn(() => () => undefined),
    },
    shortcuts: {
      set: vi.fn(async (b: { id: string }[]) => b.map((x) => ({ id: x.id, ok: true }))),
      clear: vi.fn(async () => undefined),
      onTriggered: vi.fn(() => () => undefined),
    },
    system: { mediaControls: vi.fn(async () => false), setMediaControls: vi.fn(async () => ({ restartRequired: true })), relaunch: vi.fn(async () => undefined) },
    control: {
      start: vi.fn(async (port: number) => ({ running: true, port, clients: 0, token: "tok" })),
      stop: vi.fn(async () => undefined),
      status: vi.fn(async () => ({ running: false, port: null, clients: 0, token: null })),
      regenerateToken: vi.fn(),
      pushState: vi.fn(),
      setHandler: vi.fn(),
    },
    slack: {
      test: vi.fn(async () => ({ ok: true as const })),
      setStatus: vi.fn(async () => ({ ok: true as const })),
      clearStatus: vi.fn(async () => ({ ok: true as const })),
      forget: vi.fn(async () => undefined),
    },
  };
}

function fakePlayer(isPlaying = true): PlayerApi {
  return {
    getState: () => ({ current: track, isPlaying, position: 10, duration: 200, volume: 0.5, queue: [track], index: 0 }),
    toggle: vi.fn(),
    next: vi.fn(async () => undefined),
    previous: vi.fn(async () => undefined),
    seek: vi.fn(),
    setVolume: vi.fn(),
    playTracks: vi.fn(async () => undefined),
    enqueue: vi.fn(),
  };
}

const setHost = (host: unknown) => {
  (window as unknown as { host: unknown }).host = host;
};

async function load(): Promise<Record<string, Plugin[]>> {
  vi.resetModules();
  const out: Record<string, Plugin[]> = {};
  for (const id of ids) {
    const mod = (await import(`../${id}/index.tsx`)) as { default: Plugin | Plugin[] };
    out[id] = Array.isArray(mod.default) ? mod.default : [mod.default];
  }
  return out;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  setHost(undefined);
  vi.restoreAllMocks();
});

describe("desktop-only gating", () => {
  it("contributes nothing in a browser or the phone apps (no desktop bridge when the page loads)", async () => {
    setHost(undefined);
    const plugins = await load();
    for (const id of ids) expect(plugins[id], id).toEqual([]);
  });

  it("contributes nothing when the host says it is the web player", async () => {
    setHost({ platform: "web", integrations: fakeBridge() });
    const plugins = await load();
    for (const id of ids) expect(plugins[id], id).toEqual([]);
  });

  it("is found on the desktop, with the expected ids", async () => {
    setHost({ platform: "win32", integrations: fakeBridge() });
    const plugins = await load();
    expect(ids.map((id) => plugins[id]![0]!.manifest.id)).toEqual(manifestIds);
    // None of them switch themselves on: they are opt-in.
    for (const id of ids) expect(plugins[id]![0]!.manifest.builtin).toBeFalsy();
  });

  it("does nothing if activated while the host is the web player", async () => {
    setHost({ platform: "win32", integrations: fakeBridge() });
    const plugins = await load();
    setHost({ platform: "web", integrations: fakeBridge() });
    const host = usePluginHost;
    host.setState({ plugins: [], contributions: emptyContributions() });
    setPlayerApi(fakePlayer());
    for (const id of ids) host.getState().register(plugins[id]![0]!);
    for (const mid of manifestIds) await host.getState().setEnabled(mid, true);
    const c = host.getState().contributions;
    expect(c.settings).toEqual([]);
    expect(c.commands).toEqual([]);
  });
});

describe("on the desktop", () => {
  async function enableAll(bridge: ReturnType<typeof fakeBridge>) {
    setHost({ platform: "win32", integrations: bridge, secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined } });
    const plugins = await load();
    // The host module was reloaded with the plugins: use that copy.
    const host = (await import("../../host")).usePluginHost;
    const { setPlayerApi: setApi } = await import("../../host");
    host.setState({ plugins: [], contributions: (await import("../../host")).emptyContributions() });
    setApi(fakePlayer());
    for (const id of ids) host.getState().register(plugins[id]![0]!);
    return { host, plugins };
  }

  it("each plugin adds its own settings panel", async () => {
    const bridge = fakeBridge();
    const { host } = await enableAll(bridge);
    for (const mid of manifestIds) await host.getState().setEnabled(mid, true);
    expect(host.getState().contributions.settings.map((s) => s.id).sort()).toEqual(
      ["control-api", "discord-presence", "media-keys", "obs-overlay", "status-sync"].sort(),
    );
  });

  it("media keys registers its commands and the shortcuts for them", async () => {
    const bridge = fakeBridge();
    const { host } = await enableAll(bridge);
    await host.getState().setEnabled("cadence.media-keys", true);
    const commands = host.getState().contributions.commands;
    expect(commands.map((c) => c.id)).toContain("cadence.media-keys.play-pause");
    expect(commands).toHaveLength(6);
    await vi.waitFor(() => expect(bridge.shortcuts.set).toHaveBeenCalled(), { timeout: 2000 });
    const sent = bridge.shortcuts.set.mock.calls.at(-1)![0] as { id: string; accelerator: string }[];
    expect(sent.map((b) => b.accelerator)).toContain("Ctrl+Alt+Right");
    expect(new Set(sent.map((b) => b.accelerator)).size).toBe(sent.length);
  });

  it("media keys releases the shortcuts when turned off", async () => {
    const bridge = fakeBridge();
    const { host } = await enableAll(bridge);
    await host.getState().setEnabled("cadence.media-keys", true);
    await host.getState().setEnabled("cadence.media-keys", false);
    expect(bridge.shortcuts.clear).toHaveBeenCalled();
    expect(host.getState().contributions.commands).toEqual([]);
  });

  it("the control API starts its server on the saved port, hands over a command handler and stops when disabled", async () => {
    const bridge = fakeBridge();
    const { host } = await enableAll(bridge);
    await host.getState().setEnabled("cadence.control-api", true);
    expect(bridge.control.start).toHaveBeenCalledWith(47321);
    const handler = bridge.control.setHandler.mock.calls.at(-1)![0] as (n: string, a: Record<string, unknown>) => Promise<unknown>;
    await handler("next", {});
    await expect(handler("nope", {})).rejects.toThrow("unknown_command");
    await host.getState().setEnabled("cadence.control-api", false);
    expect(bridge.control.stop).toHaveBeenCalled();
    expect(bridge.control.setHandler).toHaveBeenLastCalledWith(null);
  });

  it("Discord stays idle until an application ID is saved, then connects and shows the song", async () => {
    const bridge = fakeBridge();
    const { host } = await enableAll(bridge);
    await host.getState().setEnabled("cadence.discord-presence", true);
    expect(bridge.discord.start).not.toHaveBeenCalled();
    expect(bridge.discord.setActivity).not.toHaveBeenCalled();
    localStorage.setItem("plugin:cadence.discord-presence:settings", JSON.stringify({ applicationId: "123456789012345678" }));
    await host.getState().setEnabled("cadence.discord-presence", false);
    await host.getState().setEnabled("cadence.discord-presence", true);
    expect(bridge.discord.start).toHaveBeenCalledWith("123456789012345678");
    await vi.waitFor(() => expect(bridge.discord.setActivity).toHaveBeenCalled());
    const activity = bridge.discord.setActivity.mock.calls.at(-1)![0] as { details: string; state: string };
    expect(activity).toMatchObject({ details: "Song", state: "by Artist" });
    await host.getState().setEnabled("cadence.discord-presence", false);
    expect(bridge.discord.stop).toHaveBeenCalled();
  });

  it("Slack status sends nothing until the person opts in", async () => {
    const bridge = fakeBridge();
    const { host } = await enableAll(bridge);
    await host.getState().setEnabled("cadence.status-sync", true);
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.slack.setStatus).not.toHaveBeenCalled();
    expect(bridge.slack.clearStatus).not.toHaveBeenCalled();
  });
});