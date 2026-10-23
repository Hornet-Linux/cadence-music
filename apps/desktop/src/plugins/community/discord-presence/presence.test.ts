import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { DEFAULT_PRESENCE_SETTINGS, buildPresence, isApplicationId, type PresenceSettings } from "./presence";

const track: Track = {
  id: "s:1",
  title: "Blue in Green",
  artists: [
    { id: "a", name: "Miles Davis" },
    { id: "b", name: "Bill Evans" },
  ],
  album: "Kind of Blue",
  artwork: "https://i.scdn.co/image/abc",
  durationSec: 337,
};
const settings: PresenceSettings = { ...DEFAULT_PRESENCE_SETTINGS, applicationId: "123456789012345678" };
const NOW = 1_800_000_000_000;

describe("buildPresence", () => {
  it("shows title, artists, a running clock and public cover art while playing", () => {
    const a = buildPresence(track, { isPlaying: true, position: 37, duration: 337 }, settings, NOW);
    expect(a).toEqual({
      details: "Blue in Green",
      state: "by Miles Davis, Bill Evans",
      startMs: NOW - 37_000,
      endMs: NOW + 300_000,
      largeText: "Kind of Blue",
      largeImage: "https://i.scdn.co/image/abc",
    });
  });

  it("shows nothing when private, when there is no track, or when paused and set to hide", () => {
    const playing = { isPlaying: true, position: 0, duration: 100 };
    expect(buildPresence(track, playing, { ...settings, private: true }, NOW)).toBeNull();
    expect(buildPresence(null, playing, settings, NOW)).toBeNull();
    expect(buildPresence(track, { ...playing, isPlaying: false }, { ...settings, hideWhenPaused: true }, NOW)).toBeNull();
  });

  it("shows Paused without a clock", () => {
    const a = buildPresence(track, { isPlaying: false, position: 50, duration: 337 }, settings, NOW)!;
    expect(a.state).toBe("Paused \u00b7 Miles Davis, Bill Evans");
    expect(a.startMs).toBeUndefined();
    expect(a.endMs).toBeUndefined();
  });

  it("leaves out cover art that Discord could not fetch (private, http or missing) or that the person turned off", () => {
    const playing = { isPlaying: true, position: 1, duration: 100 };
    for (const artwork of ["http://example.com/a.jpg", "https://192.168.1.2/a.jpg", "https://nas.local/a.jpg", undefined]) {
      expect(buildPresence({ ...track, artwork }, playing, settings, NOW)!.largeImage).toBeUndefined();
    }
    expect(buildPresence(track, playing, { ...settings, showArtwork: false }, NOW)!.largeImage).toBeUndefined();
  });

  it("can hide the album and falls back to the song title as the image caption", () => {
    const playing = { isPlaying: true, position: 1, duration: 100 };
    const a = buildPresence(track, playing, { ...settings, showAlbum: false }, NOW)!;
    expect(a.largeText).toBe("Blue in Green");
  });

  it("uses the track length when the player does not know the duration yet, and omits the end when unknown", () => {
    const a = buildPresence(track, { isPlaying: true, position: 0, duration: 0 }, settings, NOW)!;
    expect(a.endMs).toBe(NOW + 337_000);
    const unknown = buildPresence({ ...track, durationSec: undefined }, { isPlaying: true, position: 0, duration: 0 }, settings, NOW)!;
    expect(unknown.endMs).toBeUndefined();
  });

  it("handles tracks with no artist", () => {
    const a = buildPresence({ ...track, artists: [] }, { isPlaying: true, position: 0, duration: 10 }, settings, NOW)!;
    expect(a.state).toBeUndefined();
  });
});

describe("isApplicationId", () => {
  it("accepts snowflakes and rejects everything else", () => {
    expect(isApplicationId(" 123456789012345678 ")).toBe(true);
    expect(isApplicationId("1234")).toBe(false);
    expect(isApplicationId("abc123456789012345678")).toBe(false);
    expect(isApplicationId("")).toBe(false);
  });
});