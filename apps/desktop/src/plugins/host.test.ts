import { beforeEach, describe, expect, it } from "vitest";
import { emptyContributions, usePluginHost } from "./host";
import type { Plugin } from "./types";
import type { Track } from "@/shared/types";

function resetHost() {
  usePluginHost.setState({
    plugins: [],
    contributions: emptyContributions(),
  });
}

const track: Track = { id: "x", title: "X", artists: [{ id: "a", name: "A" }] };

describe("plugin host", () => {
  beforeEach(resetHost);

  it("activates a plugin and collects its contributions", async () => {
    const plugin: Plugin = {
      manifest: {
        id: "test.sidebar",
        name: "Sidebar",
        version: "1.0.0",
        capabilities: ["ui.sidebar"],
        apiRange: "^1.0.0",
      },
      activate(ctx) {
        ctx.registerSidebarItem({ id: "p", label: "P", render: () => null });
      },
    };
    usePluginHost.getState().register(plugin);
    await usePluginHost.getState().setEnabled("test.sidebar", true);

    const { contributions, plugins } = usePluginHost.getState();
    expect(contributions.sidebar.map((s) => s.id)).toContain("p");
    expect(plugins.find((p) => p.plugin.manifest.id === "test.sidebar")?.enabled).toBe(true);
  });

  it("refuses a contribution the manifest did not declare", async () => {
    const plugin: Plugin = {
      manifest: {
        id: "test.ungranted",
        name: "Ungranted",
        version: "1.0.0",
        capabilities: [], // no ui.sidebar
        apiRange: "^1.0.0",
      },
      activate(ctx) {
        ctx.registerSidebarItem({ id: "nope", label: "Nope", render: () => null });
      },
    };
    usePluginHost.getState().register(plugin);
    await expect(usePluginHost.getState().setEnabled("test.ungranted", true)).rejects.toThrow(
      /ui\.sidebar/,
    );
  });

  it("resolves audio through the first source that returns a url", async () => {
    const plugin: Plugin = {
      manifest: {
        id: "test.source",
        name: "Source",
        version: "1.0.0",
        capabilities: ["source.audio"],
        apiRange: "^1.0.0",
      },
      activate(ctx) {
        ctx.registerAudioSource({ id: "s1", label: "S1", resolve: async () => null });
        ctx.registerAudioSource({ id: "s2", label: "S2", resolve: async () => "blob:play-me" });
      },
    };
    usePluginHost.getState().register(plugin);
    await usePluginHost.getState().setEnabled("test.source", true);

    expect(await usePluginHost.getState().resolveAudio(track)).toBe("blob:play-me");
  });

  it("returns null when no source can resolve a track", async () => {
    expect(await usePluginHost.getState().resolveAudio(track)).toBeNull();
  });

  it("keeps every built-in's contributions when they enable concurrently", async () => {
    const sidebarPlugin = (id: string): Plugin => ({
      manifest: {
        id,
        name: id,
        version: "1.0.0",
        capabilities: ["ui.sidebar"],
        apiRange: "^1.0.0",
        builtin: true,
      },
      activate(ctx) {
        ctx.registerSidebarItem({ id, label: id, render: () => null });
      },
    });
    const host = usePluginHost.getState();
    host.register(sidebarPlugin("race.a"));
    host.register(sidebarPlugin("race.b"));
    host.register(sidebarPlugin("race.c"));
    await usePluginHost.getState().whenIdle();

    const ids = usePluginHost.getState().contributions.sidebar.map((s) => s.id);
    expect(ids).toEqual(["race.a", "race.b", "race.c"]);
  });

  it("orders setup steps by weight and gates them on ui.settings", async () => {
    const step = (id: string, weight: number) => ({ id, title: id, weight, render: () => null });
    const plugin: Plugin = {
      manifest: { id: "test.steps", name: "Steps", version: "1.0.0", capabilities: ["ui.settings"], apiRange: "^1.0.0" },
      activate(ctx) {
        ctx.registerSetupStep(step("low", 10));
        ctx.registerSetupStep(step("high", 100));
      },
    };
    const ungated: Plugin = {
      manifest: { id: "test.steps-ungated", name: "Ungated", version: "1.0.0", capabilities: [], apiRange: "^1.0.0" },
      activate(ctx) {
        ctx.registerSetupStep(step("nope", 1));
      },
    };
    const host = usePluginHost.getState();
    host.register(plugin);
    host.register(ungated);
    await host.setEnabled("test.steps", true);
    expect(usePluginHost.getState().contributions.setupSteps.map((s) => s.id)).toEqual(["high", "low"]);
    await expect(host.setEnabled("test.steps-ungated", true)).rejects.toThrow(/ui\.settings/);
  });

  it("does not duplicate now-playing listeners when plugins are toggled", async () => {
    let calls = 0;
    const listener: Plugin = {
      manifest: {
        id: "test.listener",
        name: "Listener",
        version: "1.0.0",
        capabilities: ["player.read"],
        apiRange: "^1.0.0",
      },
      activate(ctx) {
        ctx.onNowPlaying(() => calls++);
      },
    };
    const other: Plugin = {
      manifest: { id: "test.other", name: "Other", version: "1.0.0", capabilities: [], apiRange: "^1.0.0" },
      activate() {},
    };
    const host = usePluginHost.getState();
    host.register(listener);
    host.register(other);
    await host.setEnabled("test.listener", true);
    await host.setEnabled("test.other", true);
    await host.setEnabled("test.other", false);

    usePluginHost.getState().emitNowPlaying(track);
    expect(calls).toBe(1);
  });
});
