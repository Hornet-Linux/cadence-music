import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppleMusic } from "@/plugins/builtins/appleMusic/appleMusicStore";
import { useSpotify } from "@/plugins/builtins/spotify/spotifyStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { keyStorageNote, useProviders } from "@/features/dj/providers";

const win = window as unknown as Record<string, unknown>;

function seedStorage() {
  const entries: Record<string, string> = {
    "secret:server.token": "cadence-token",
    "secret:spotify.session": '{"clientId":"abc","refreshToken":"r"}',
    "spotify:clientId": "abc",
    "secret:dj.key.k1": "sk-secret",
    "secret:dj.key.k2": "sk-other",
    "dj:providers": '[{"id":"k1","name":"OpenAI"}]',
    "dj:provider": "local:k1",
    "dj:device-id": "d-123",
    "dj:llm": "{}",
    "music.TEAM.media-user-token": "apple-token",
    "server:url": "https://music.example",
    "dj:voice": "0",
  };
  for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
}

function setHost(platform: string) {
  const spotifyLogout = vi.fn(async () => {
    localStorage.removeItem("secret:spotify.session");
  });
  win.host = {
    platform,
    secrets: {
      get: async (k: string) => localStorage.getItem(`secret:${k}`),
      set: async (k: string, v: string) => localStorage.setItem(`secret:${k}`, v),
      delete: async (k: string) => localStorage.removeItem(`secret:${k}`),
    },
    spotify: { logout: spotifyLogout },
  };
  return spotifyLogout;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  delete win.host;
  delete win.MusicKit;
  vi.unstubAllGlobals();
});

describe("signing out of the web player", () => {
  it("forgets Spotify, Apple Music and AI provider data in storage and memory", async () => {
    const spotifyLogout = setHost("web");
    const unauthorize = vi.fn(async () => undefined);
    win.MusicKit = { getInstance: () => ({ unauthorize }) };
    seedStorage();
    useServer.setState({ token: "cadence-token", url: "https://music.example" });
    useSpotify.setState({
      status: "signed-in",
      clientId: "abc",
      profile: { name: "Previous Person", premium: true },
      tracks: [{ id: "spotify:track:1" } as never],
      total: 1,
    });
    useAppleMusic.setState({ status: "signed-in", tracks: [{ id: "apple:song:1" } as never], total: 1 });
    useProviders.setState({
      local: [{ id: "k1", name: "OpenAI", kind: "openai-compatible", baseUrl: "https://api.openai.com", model: "m", share: false }],
      selected: "local:k1",
    });

    await useServer.getState().logout();

    expect(spotifyLogout).toHaveBeenCalled();
    expect(unauthorize).toHaveBeenCalled();
    expect(Object.keys(localStorage).sort()).toEqual(["dj:voice", "server:url"]);

    expect(useServer.getState().token).toBeNull();
    const spotify = useSpotify.getState();
    expect(spotify).toMatchObject({ status: "signed-out", clientId: "", profile: null, tracks: [], total: 0 });
    expect(useAppleMusic.getState()).toMatchObject({ status: "unavailable", tracks: [], total: 0 });
    expect(useProviders.getState().selected).toBe("");
    expect(useProviders.getState().local.map((p) => p.id)).toEqual(["ollama"]);
  });

  it("still clears storage when MusicKit can't sign out", async () => {
    setHost("web");
    win.MusicKit = {
      getInstance: () => {
        throw new Error("not configured");
      },
    };
    seedStorage();
    await useServer.getState().logout();
    expect(localStorage.getItem("music.TEAM.media-user-token")).toBeNull();
    expect(localStorage.getItem("secret:dj.key.k1")).toBeNull();
  });

  it("leaves the desktop app's data alone", async () => {
    setHost("win32");
    seedStorage();
    await useServer.getState().logout();
    expect(localStorage.getItem("secret:dj.key.k1")).toBe("sk-secret");
    expect(localStorage.getItem("dj:providers")).not.toBeNull();
    expect(localStorage.getItem("spotify:clientId")).toBe("abc");
  });
});

describe("API key storage note", () => {
  it("is truthful per platform", () => {
    setHost("web");
    expect(keyStorageNote()).toMatch(/this browser and removed when you sign out/);
    setHost("win32");
    expect(keyStorageNote()).toMatch(/secure storage/);
  });
});
