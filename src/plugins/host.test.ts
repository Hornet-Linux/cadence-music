import { beforeEach, describe, expect, it } from "vitest";
import { usePluginHost } from "./host";
import type { Plugin } from "./types";
import type { Track } from "@/shared/types";

function resetHost() {
  usePluginHost.setState({
    plugins: [],
    contributions: {
      sidebar: [],
      homeWidgets: [],
      settings: [],
      audioSources: [],
      librarySources: [],
    },
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
});
