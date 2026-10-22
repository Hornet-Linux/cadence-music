import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { emptyContributions, usePluginHost } from "@/plugins/host";
import { ApiError, useServer } from "@/plugins/builtins/server/serverStore";
import type { Track } from "@/shared/types";
import deezer, { useDeezer } from "../deezer";
import soundcloud, { useSoundCloud } from "../soundcloud";
import tidal from "../tidal";
import youtube, { useYouTube } from "../youtube-music";
import { createStreamingStore } from "./store";
import { Attribution, ServiceSettings } from "./ui";
import type { ServiceInfo, StreamStatus } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plugins = [youtube, soundcloud, deezer, tidal];
let api: ReturnType<typeof vi.fn>;

beforeEach(() => {
  api = vi.fn().mockRejectedValue(new ApiError("Request failed (404)", 404));
  useServer.setState({ url: "https://cadence.example", token: "tok", user: { id: 1, username: "ann", displayName: null, email: null, isAdmin: false }, api: api as never });
  usePluginHost.setState({ plugins: [], contributions: emptyContributions() });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the four streaming plugins", () => {
  it("are opt-in community plugins with ids cadence.<name>", () => {
    expect(plugins.map((p) => p.manifest.id)).toEqual(["cadence.youtube-music", "cadence.soundcloud", "cadence.deezer", "cadence.tidal"]);
    for (const p of plugins) {
      expect(p.manifest.builtin).toBe(false);
      expect(p.manifest.capabilities).toContain("network.outbound");
      expect(p.manifest.capabilities).toContain("ui.settings");
    }
  });

  it("only those that can play inside Cadence claim the audio-source capability", () => {
    const withAudio = plugins.filter((p) => p.manifest.capabilities.includes("source.audio")).map((p) => p.manifest.id);
    expect(withAudio).toEqual(["cadence.youtube-music", "cadence.soundcloud", "cadence.deezer"]);
  });

  it("register a settings panel, a page, a library section and track actions when enabled, and nothing before", async () => {
    for (const p of plugins) usePluginHost.getState().register(p);
    expect(usePluginHost.getState().contributions.sidebar).toHaveLength(0);
    for (const p of plugins) await usePluginHost.getState().setEnabled(p.manifest.id, true);
    const c = usePluginHost.getState().contributions;
    expect(c.sidebar.map((s) => s.id).sort()).toEqual(["deezer", "soundcloud", "tidal", "youtube-music"]);
    expect(c.settings.map((s) => s.id).sort()).toEqual(["deezer", "soundcloud", "tidal", "youtube-music"]);
    expect(c.librarySources).toHaveLength(4);
    expect(c.audioSources.map((s) => s.id).sort()).toEqual(["deezer", "soundcloud", "youtube-music"]);
    expect(c.trackActions.some((a) => a.label === "Play full track in Deezer's player")).toBe(true);
  });

  it("make no network calls until enabled, and degrade quietly when the server lacks the add-on", async () => {
    usePluginHost.getState().register(deezer);
    expect(api).not.toHaveBeenCalled();
    await usePluginHost.getState().setEnabled("cadence.deezer", true);
    await vi.waitFor(() => expect(useDeezer.getState().missing).toBe(true));
    expect(useDeezer.getState().error).toBeNull();
  });
});

describe("audio sources", () => {
  const track = (id: string, source: string): Track => ({ id, title: "T", artists: [{ id: "a", name: "A" }], source });

  async function enable(p: typeof deezer) {
    usePluginHost.getState().register(p);
    await usePluginHost.getState().setEnabled(p.manifest.id, true);
  }

  it("Deezer asks the server for a fresh preview URL each time", async () => {
    await enable(deezer);
    api.mockResolvedValue({ url: "https://cdn.example/preview.mp3" });
    expect(await usePluginHost.getState().resolveAudio(track("deezer:77", "deezer"))).toBe("https://cdn.example/preview.mp3");
    expect(api).toHaveBeenLastCalledWith("api/streaming/deezer/tracks/77/preview", undefined);
    api.mockResolvedValue({ url: "https://cdn.example/preview2.mp3" });
    expect(await usePluginHost.getState().resolveAudio(track("deezer:77", "deezer"))).toBe("https://cdn.example/preview2.mp3");
  });

  it("Deezer tracks that only link out stay unresolved instead of calling the server", async () => {
    await enable(deezer);
    useDeezer.setState({ playback: { "deezer:5": "link" } });
    api.mockClear();
    expect(await usePluginHost.getState().resolveAudio(track("deezer:5", "deezer"))).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it("a failed preview lookup leaves the track unresolved and says why", async () => {
    await enable(deezer);
    api.mockRejectedValue(new ApiError("Request failed (404): Deezer offers no preview for this track", 404, "no_preview"));
    expect(await usePluginHost.getState().resolveAudio(track("deezer:9", "deezer"))).toBeNull();
    expect(useDeezer.getState().error).toMatch(/no preview/);
  });

  it("SoundCloud blocked tracks are not playable here", async () => {
    await enable(soundcloud);
    useSoundCloud.setState({ playback: { "soundcloud:1": "link" } });
    expect(await usePluginHost.getState().resolveAudio(track("soundcloud:1", "soundcloud"))).toBeNull();
  });

  it("YouTube and SoundCloud hand the host an external player (not a hidden audio URL)", async () => {
    await enable(youtube);
    const yt = await usePluginHost.getState().resolveAudio(track("youtube:dQw4w9WgXcQ", "youtube-music"));
    expect(typeof yt).toBe("object");
    await (yt as { stop: () => Promise<void> }).stop();
    await enable(soundcloud);
    useSoundCloud.setState({ playback: { "soundcloud:5": "widget" } });
    const sc = await usePluginHost.getState().resolveAudio(track("soundcloud:5", "soundcloud"));
    expect(typeof sc).toBe("object");
    await (sc as { stop: () => Promise<void> }).stop();
  });

  it("other sources' tracks are left alone", async () => {
    await enable(youtube);
    expect(await usePluginHost.getState().resolveAudio(track("server:1", "server"))).toBeNull();
    expect(useYouTube.getState().error).toBeNull();
  });
});

describe("settings panel", () => {
  const info: ServiceInfo = {
    slug: "demo",
    name: "Demo",
    prefix: "demo:",
    homepage: "https://demo.example/",
    credit: { text: "Powered by Demo", href: "https://demo.example/" },
    termsHref: "https://demo.example/terms",
    adminHelp: "Get credentials at demo.example.",
    capabilities: { works: ["Search Demo."], limits: ["No downloads."] },
  };
  const base: StreamStatus = {
    service: "demo",
    name: "Demo",
    configured: false,
    connected: false,
    hasLogin: true,
    features: { search: true, library: true, playlists: true, playback: "preview" },
  };
  let root: Root;
  let host: HTMLElement;

  async function show(store: ReturnType<typeof createStreamingStore>) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<ServiceSettings store={store} info={info} />);
    });
  }

  afterEach(() => act(() => root.unmount()));

  it("explains that the server owner has to add credentials, and always shows the credit and limits", async () => {
    api.mockImplementation(async (route: string) => (route.endsWith("/status") ? base : undefined));
    await show(createStreamingStore(info));
    expect(host.textContent).toMatch(/Demo isn't set up on this server yet/);
    expect(host.textContent).toContain("No downloads.");
    const credit = host.querySelector(".stream-credit a") as HTMLAnchorElement;
    expect(credit.textContent).toBe("Powered by Demo");
    expect(credit.rel).toContain("noopener");
    // A normal member sees no credential form.
    expect(host.querySelector("form")).toBeNull();
  });

  it("shows the owner the credential form with a write-only secret and the redirect address", async () => {
    useServer.setState({ user: { id: 1, username: "root", displayName: null, email: null, isAdmin: true } });
    api.mockImplementation(async (route: string) =>
      route.endsWith("/status")
        ? base
        : route.endsWith("/config")
          ? {
              configured: false,
              redirectUri: "https://cadence.example/api/streaming/demo/callback",
              fields: [
                { key: "clientId", label: "Client ID", secret: false, optional: false, set: false },
                { key: "clientSecret", label: "Client secret", secret: true, optional: false, set: true },
              ],
            }
          : undefined,
    );
    await show(createStreamingStore(info));
    await vi.waitFor(() => expect(host.querySelector("form")).not.toBeNull());
    expect(host.textContent).toContain("https://cadence.example/api/streaming/demo/callback");
    const secret = host.querySelector('input[type="password"]') as HTMLInputElement;
    expect(secret.value).toBe("");
    expect(secret.placeholder).toMatch(/Saved/);
  });

  it("offers Connect once configured, and Disconnect once connected", async () => {
    api.mockImplementation(async (route: string) => (route.endsWith("/status") ? { ...base, configured: true } : { items: [] }));
    const store = createStreamingStore(info);
    await show(store);
    await vi.waitFor(() => expect(host.textContent).toContain("Connect Demo"));
    api.mockImplementation(async (route: string) => (route.endsWith("/status") ? { ...base, configured: true, connected: true } : { items: [] }));
    await act(async () => {
      await store.getState().refresh();
    });
    expect(host.textContent).toContain("Disconnect");
  });

  it("the credit component links to the service and its terms", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<Attribution info={info} />);
    });
    const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://demo.example/", "https://demo.example/terms"]);
  });
});
