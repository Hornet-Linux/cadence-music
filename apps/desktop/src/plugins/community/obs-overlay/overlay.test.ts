import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { DEFAULT_OVERLAY_OPTIONS, buildHeartbeat, overlayUrl } from "./overlay";

const track: Track = {
  id: "server:1",
  title: "Song",
  artists: [{ id: "a", name: "Artist" }],
  album: "Album",
  artwork: "https://i.scdn.co/x",
  durationSec: 180,
  source: "server",
};

describe("overlayUrl", () => {
  it("builds a plain link with the defaults", () => {
    expect(overlayUrl("https://music.example.com", "np_abc", DEFAULT_OVERLAY_OPTIONS)).toBe("https://music.example.com/overlay/np_abc");
  });
  it("keeps a server path prefix and adds only the options that differ", () => {
    expect(
      overlayUrl("https://example.com/cadence", "np_abc", {
        theme: "bar",
        showArt: false,
        showProgress: false,
        align: "right",
        scale: 1.5,
      }),
    ).toBe("https://example.com/cadence/overlay/np_abc?theme=bar&art=0&progress=0&align=right&scale=1.5");
  });
  it("clamps the scale", () => {
    expect(overlayUrl("http://localhost:8787/", "t", { ...DEFAULT_OVERLAY_OPTIONS, scale: 9 })).toBe("http://localhost:8787/overlay/t?scale=3");
  });
});

describe("buildHeartbeat", () => {
  it("reports stopped with no track", () => {
    expect(buildHeartbeat({ current: null, isPlaying: false, position: 0, duration: 0 })).toEqual({ state: "stopped" });
  });
  it("sends only what the overlay shows", () => {
    expect(buildHeartbeat({ current: track, isPlaying: true, position: 12.345, duration: 0 })).toEqual({
      state: "playing",
      track: { id: "server:1", title: "Song", artists: [{ name: "Artist" }], album: "Album", artwork: "https://i.scdn.co/x" },
      positionSec: 12.3,
      durationSec: 180,
    });
  });
  it("reports paused", () => {
    expect(buildHeartbeat({ current: track, isPlaying: false, position: 5, duration: 170 })).toMatchObject({ state: "paused", durationSec: 170 });
  });
});