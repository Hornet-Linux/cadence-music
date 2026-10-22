import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JellyfinTrack } from "@uma/shared";
import type { Track } from "@/shared/types";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { useJellyfin } from "@/plugins/builtins/jellyfin/jellyfinStore";

const requestPicks = vi.fn();
vi.mock("./providers", () => ({ requestPicks: (...args: unknown[]) => requestPicks(...args) }));

const spotifyState = { status: "signed-in" as string, tracks: [] as Track[] };
vi.mock("@/plugins/builtins/spotify/spotifyStore", () => ({
  useSpotify: Object.assign((select: (s: typeof spotifyState) => unknown) => select(spotifyState), {
    getState: () => spotifyState,
  }),
}));

const { planDjSet } = await import("./dj");
const { chooseDjSource, connectSourceMessage, jellyfinSource, loadSourcePref, saveSourcePref, spotifySource } = await import("./sources");

const jt = (id: string, title: string, artist: string): JellyfinTrack => ({ id, title, artists: [artist] });
const profile = { topArtists: ["A"], genres: [], topTracks: [], recentTracks: [] };

let api: ReturnType<typeof vi.fn>;
const connect = (on: boolean) => useJellyfin.setState({ status: on ? { configured: true, connected: true } : null });

beforeEach(() => {
  api = vi.fn();
  useServer.setState({ url: "https://cadence.example", token: "tok", api: api as never });
  useJellyfin.getState().reset();
  spotifyState.status = "signed-in";
  requestPicks.mockReset();
  localStorage.clear();
});

describe("choosing the DJ's music source", () => {
  it("auto prefers Jellyfin when connected, otherwise Spotify", () => {
    expect(chooseDjSource("auto")?.id).toBe("spotify");
    connect(true);
    expect(chooseDjSource("auto")?.id).toBe("jellyfin");
    spotifyState.status = "signed-out";
    expect(chooseDjSource("auto")?.id).toBe("jellyfin");
  });

  it("is null when nothing is connected", () => {
    spotifyState.status = "signed-out";
    expect(chooseDjSource("auto")).toBeNull();
  });

  it("honours an explicit choice and does not fall back to the other source", () => {
    connect(true);
    expect(chooseDjSource("spotify")?.id).toBe("spotify");
    expect(chooseDjSource("jellyfin")?.id).toBe("jellyfin");
    connect(false);
    expect(chooseDjSource("jellyfin")).toBeNull();
    spotifyState.status = "signed-out";
    connect(true);
    expect(chooseDjSource("spotify")).toBeNull();
  });

  it("words the 'connect' message for the choice", () => {
    expect(connectSourceMessage("auto")).toBe("Connect Spotify or Jellyfin to use the DJ.");
    expect(connectSourceMessage("jellyfin")).toContain("Connect Jellyfin to use the DJ");
    expect(connectSourceMessage("spotify")).toContain("Connect Spotify to use the DJ");
  });

  it("remembers the choice, ignoring junk", () => {
    expect(loadSourcePref()).toBe("auto");
    saveSourcePref("jellyfin");
    expect(localStorage.getItem("dj:source")).toBe("jellyfin");
    expect(loadSourcePref()).toBe("jellyfin");
    localStorage.setItem("dj:source", "plex");
    expect(loadSourcePref()).toBe("auto");
  });
});

describe("Jellyfin as the DJ's source", () => {
  it("takes its taste from the server and complains when it is empty", async () => {
    api.mockResolvedValueOnce(profile);
    expect(await jellyfinSource.taste()).toEqual(profile);
    expect(api).toHaveBeenCalledWith("api/jellyfin/taste", undefined);
    api.mockResolvedValueOnce({ topArtists: [], genres: [], topTracks: [], recentTracks: [] });
    await expect(jellyfinSource.taste()).rejects.toThrow(/jellyfin first/i);
  });

  it("plans a set from the library tracks the server matched", async () => {
    requestPicks.mockResolvedValue([
      { artist: "A", title: "One", intro: "first" },
      { artist: "B", title: "Missing", intro: "nope" },
      { artist: "C", title: "Three", intro: "third" },
      { artist: "A", title: "One", intro: "dupe" },
    ]);
    api.mockResolvedValue({ matches: [jt("1", "One", "A"), null, jt("3", "Three", "C"), jt("1", "One", "A")] });

    const set = await planDjSet("local:x", profile, { count: 2, mood: "rainy" }, jellyfinSource);

    expect(set.map((d) => [d.track.id, d.track.source, d.intro])).toEqual([
      ["jellyfin:1", "jellyfin", "first"],
      ["jellyfin:3", "jellyfin", "third"],
    ]);
    // Asks for a few extra picks, as for Spotify.
    expect(requestPicks.mock.calls[0][2]).toMatchObject({ count: 5, mood: "rainy" });
    const [route, init] = api.mock.calls[0];
    expect(route).toBe("api/jellyfin/match");
    expect(JSON.parse(init.body).picks[1]).toEqual({ artist: "B", title: "Missing" });
  });

  it("skips tracks already played this session", async () => {
    requestPicks.mockResolvedValue([
      { artist: "A", title: "One", intro: "" },
      { artist: "C", title: "Three", intro: "" },
    ]);
    api.mockResolvedValue({ matches: [jt("1", "One", "A"), jt("3", "Three", "C")] });
    const history = [{ track: { id: "jellyfin:1", title: "One", artists: [{ id: "A", name: "A" }] }, intro: "" }];
    const set = await planDjSet("local:x", profile, { history }, jellyfinSource);
    expect(set.map((d) => d.track.id)).toEqual(["jellyfin:3"]);
    expect(requestPicks.mock.calls[0][2].avoid).toEqual(["A – One"]);
  });

  it("names Jellyfin when none of the picks exist", async () => {
    requestPicks.mockResolvedValue([{ artist: "A", title: "One", intro: "" }]);
    api.mockResolvedValue({ matches: [null] });
    await expect(planDjSet("local:x", profile, {}, jellyfinSource)).rejects.toThrow("found on Jellyfin");
  });

  it("Spotify keeps its own wording", () => {
    expect(spotifySource.label).toBe("Spotify");
  });
});
