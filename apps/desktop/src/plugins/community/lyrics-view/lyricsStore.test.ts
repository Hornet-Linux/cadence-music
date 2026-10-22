import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { emptyContributions, usePluginHost } from "@/plugins/host";
import type { Lyrics, LyricsProvider, PlaybackEvent, PluginContext } from "../../types";
import { registerLyricsTranslator, useLyricsTranslators } from "./api";
import { playbackPosition, seekTo, startLyricsView, stopLyricsView, useLyricsView } from "./lyricsStore";

const track = (id: string): Track => ({ id, title: `Song ${id}`, artists: [{ id: "a", name: "Artist" }] });
const lyrics: Lyrics = { lines: [{ timeSec: 1, text: "one" }, { timeSec: 2, text: "two" }], synced: true, source: "Test" };

function fakeContext() {
  const store = new Map<string, unknown>();
  let onTrack: (t: Track | null) => void = () => undefined;
  let onPlay: (e: PlaybackEvent) => void = () => undefined;
  const player = {
    getState: vi.fn(() => ({ current: null as Track | null, isPlaying: false, position: 12.5, duration: 100, volume: 1, queue: [], index: 0 })),
    seek: vi.fn(),
  };
  const ctx = {
    can: () => true,
    player,
    storage: {
      get: <T>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
      set: (k: string, v: unknown) => void store.set(k, v),
      remove: (k: string) => void store.delete(k),
    },
    onNowPlaying: (cb: (t: Track | null) => void) => ((onTrack = cb), () => undefined),
    onPlayback: (cb: (e: PlaybackEvent) => void) => ((onPlay = cb), () => undefined),
  } as unknown as PluginContext;
  return { ctx, player, store, track: (t: Track | null) => onTrack(t), play: (e: PlaybackEvent) => onPlay(e) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function provide(...providers: LyricsProvider[]) {
  usePluginHost.setState({ contributions: { ...emptyContributions(), lyricsProviders: providers } });
}

describe("lyrics view store", () => {
  let detach = () => undefined as void;
  beforeEach(() => {
    useLyricsView.setState({ track: null, phase: "idle", lyrics: null, query: null, choice: "auto", translateOn: false, translatedLines: null, translateStatus: "idle", translateError: null });
    useLyricsTranslators.setState({ translators: [] });
  });
  afterEach(() => {
    detach();
    stopLyricsView();
  });

  it("follows the playing track and loads lyrics only while a view is attached", async () => {
    const getLyrics = vi.fn(async () => lyrics);
    provide({ id: "p", label: "P", getLyrics });
    const f = fakeContext();
    startLyricsView(f.ctx);
    f.track(track("1"));
    await settle();
    expect(getLyrics).not.toHaveBeenCalled();
    expect(useLyricsView.getState().phase).toBe("idle");

    detach = useLyricsView.getState().attach();
    await settle();
    expect(getLyrics).toHaveBeenCalledTimes(1);
    expect(useLyricsView.getState()).toMatchObject({ phase: "ready", providerId: "p", lyrics });

    f.track(track("2"));
    await settle();
    expect(getLyrics).toHaveBeenCalledTimes(2);
    expect(useLyricsView.getState().track?.id).toBe("2");
  });

  it("tracks play and pause", () => {
    const f = fakeContext();
    startLyricsView(f.ctx);
    f.play({ kind: "play", track: null, position: 0 });
    expect(useLyricsView.getState().isPlaying).toBe(true);
    f.play({ kind: "pause", track: null, position: 1 });
    expect(useLyricsView.getState().isPlaying).toBe(false);
  });

  it("explains when no lyrics provider is enabled, then loads once one appears", async () => {
    provide();
    const f = fakeContext();
    startLyricsView(f.ctx);
    detach = useLyricsView.getState().attach();
    f.track(track("1"));
    await settle();
    expect(useLyricsView.getState().phase).toBe("no-providers");
    provide({ id: "p", label: "P", getLyrics: async () => lyrics });
    await useLyricsView.getState().load();
    expect(useLyricsView.getState().phase).toBe("ready");
  });

  it("reports none vs error, and a manual search replaces the title and artist", async () => {
    const seen: Track[] = [];
    provide({ id: "p", label: "P", getLyrics: async (t) => (seen.push(t), null) });
    const f = fakeContext();
    startLyricsView(f.ctx);
    detach = useLyricsView.getState().attach();
    f.track(track("1"));
    await settle();
    expect(useLyricsView.getState().phase).toBe("none");

    useLyricsView.getState().search({ title: "Other Name", artist: "Someone Else" });
    await settle();
    expect(seen.at(-1)).toMatchObject({ title: "Other Name", artists: [{ name: "Someone Else" }] });
    expect(seen.at(-1)).not.toHaveProperty("durationSec");

    provide({ id: "p", label: "Broken", getLyrics: async () => Promise.reject(new Error("offline")) });
    await useLyricsView.getState().load();
    expect(useLyricsView.getState()).toMatchObject({ phase: "error", errors: ["Broken: offline"] });
  });

  it("translates through a registered translator, and says why it failed", async () => {
    provide({ id: "p", label: "P", getLyrics: async () => lyrics });
    const f = fakeContext();
    startLyricsView(f.ctx);
    detach = useLyricsView.getState().attach();
    f.track(track("1"));
    await settle();

    useLyricsView.getState().setTranslateOn(true);
    await settle();
    expect(useLyricsView.getState()).toMatchObject({ translateStatus: "error", translateError: expect.stringMatching(/translation plugin/i) });

    const translate = vi.fn(async ({ lines, target }: { lines: string[]; target: string }) => lines.map((l) => `${target}:${l}`));
    const off = registerLyricsTranslator({ id: "t", label: "T", translate });
    await settle();
    expect(useLyricsView.getState()).toMatchObject({ translateStatus: "ready", translatedLines: ["English:one", "English:two"] });

    useLyricsView.getState().setTranslateLanguage("French");
    await settle();
    expect(useLyricsView.getState().translatedLines).toEqual(["French:one", "French:two"]);

    translate.mockRejectedValueOnce(new Error("No AI provider is set up."));
    useLyricsView.getState().setTranslateLanguage("German");
    await settle();
    expect(useLyricsView.getState()).toMatchObject({ translateStatus: "error", translateError: "No AI provider is set up.", translatedLines: null });
    off();
  });

  it("keeps text size within bounds and remembers it", () => {
    const f = fakeContext();
    startLyricsView(f.ctx);
    useLyricsView.getState().setFontScale(9);
    expect(useLyricsView.getState().fontScale).toBe(1.8);
    useLyricsView.getState().setFontScale(0.1);
    expect(useLyricsView.getState().fontScale).toBe(0.8);
    useLyricsView.getState().setFontScale(1.3);
    expect(f.store.get("prefs")).toMatchObject({ fontScale: 1.3 });
    startLyricsView(fakeContext().ctx);
    expect(useLyricsView.getState().fontScale).toBe(1);
  });

  it("reads the position and seeks through the player handle", () => {
    const f = fakeContext();
    startLyricsView(f.ctx);
    expect(playbackPosition()).toBe(12.5);
    seekTo(42);
    expect(f.player.seek).toHaveBeenCalledWith(42);
  });
});
