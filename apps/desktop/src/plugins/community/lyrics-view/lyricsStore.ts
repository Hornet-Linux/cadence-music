import { create } from "zustand";
import type { Track } from "@/shared/types";
import { usePluginHost } from "@/plugins/host";
import type { Lyrics, PluginContext } from "../../types";
import { isInstrumental } from "./lrc";
import { findLyrics } from "./loader";
import { TRANSLATE_LANGUAGES, useLyricsTranslators } from "./api";

export type Phase = "idle" | "no-providers" | "loading" | "ready" | "none" | "error";
export type TranslateStatus = "idle" | "loading" | "ready" | "error";

export const FONT_MIN = 0.8;
export const FONT_MAX = 1.8;
export const FONT_STEP = 0.1;

interface Prefs {
  fontScale?: number;
  choice?: string;
  translateOn?: boolean;
  translateLanguage?: string;
}

interface LyricsViewState {
  track: Track | null;
  isPlaying: boolean;
  phase: Phase;
  lyrics: Lyrics | null;
  /** The provider that supplied the lyrics. */
  providerId: string | null;
  errors: string[];
  /** "auto" tries every provider in order; otherwise a provider id. */
  choice: string;
  /** A manual search that replaces the title and artist of the playing track. */
  query: { title: string; artist: string } | null;
  fontScale: number;
  karaoke: boolean;

  translateOn: boolean;
  translateLanguage: string;
  translateStatus: TranslateStatus;
  translatedLines: string[] | null;
  translateError: string | null;

  setTrack: (track: Track | null) => void;
  load: (options?: { fresh?: boolean }) => Promise<void>;
  setChoice: (choice: string) => void;
  search: (query: { title: string; artist: string } | null, fresh?: boolean) => void;
  setFontScale: (scale: number) => void;
  setKaraoke: (open: boolean) => void;
  setTranslateOn: (on: boolean) => void;
  setTranslateLanguage: (language: string) => void;
  /** Called by views while mounted; lookups only happen while somebody is looking. */
  attach: () => () => void;
}

let host: PluginContext | null = null;
let stops: (() => void)[] = [];
let attached = 0;
let loadToken = 0;
let loadAbort: AbortController | null = null;
let translateToken = 0;
let translateAbort: AbortController | null = null;

function savePrefs(partial: Prefs) {
  if (!host?.can("storage")) return;
  try {
    host.storage.set("prefs", { ...(host.storage.get<Prefs>("prefs") ?? {}), ...partial });
  } catch {
    // Preferences are optional.
  }
}

function readPrefs(): Prefs {
  if (!host?.can("storage")) return {};
  try {
    return host.storage.get<Prefs>("prefs") ?? {};
  } catch {
    return {};
  }
}

const clampScale = (n: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n * 10) / 10));

export const useLyricsView = create<LyricsViewState>((set, get) => {
  async function runTranslate() {
    const { translateOn, lyrics, track, translateLanguage } = get();
    translateAbort?.abort();
    const token = ++translateToken;
    if (!translateOn || !lyrics || !track || isInstrumental(lyrics)) {
      set({ translateStatus: "idle", translatedLines: null, translateError: null });
      return;
    }
    const translator = useLyricsTranslators.getState().translators[0];
    if (!translator) {
      set({ translateStatus: "error", translatedLines: null, translateError: "Turn on the Lyrics translation plugin in Settings to translate lyrics." });
      return;
    }
    translateAbort = new AbortController();
    set({ translateStatus: "loading", translatedLines: null, translateError: null });
    try {
      const lines = lyrics.lines.map((l) => l.text);
      const result = await translator.translate({ track, lines, target: translateLanguage, signal: translateAbort.signal });
      if (token !== translateToken) return;
      if (!Array.isArray(result) || result.length !== lines.length) throw new Error("The translation came back incomplete. Try again.");
      set({ translateStatus: "ready", translatedLines: result, translateError: null });
    } catch (err) {
      if (token !== translateToken || (err instanceof DOMException && err.name === "AbortError")) return;
      set({ translateStatus: "error", translatedLines: null, translateError: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    track: null,
    isPlaying: false,
    phase: "idle",
    lyrics: null,
    providerId: null,
    errors: [],
    choice: "auto",
    query: null,
    fontScale: 1,
    karaoke: false,
    translateOn: false,
    translateLanguage: "English",
    translateStatus: "idle",
    translatedLines: null,
    translateError: null,

    setTrack(track) {
      const current = get().track;
      if (track?.id === current?.id && track?.title === current?.title) return;
      loadAbort?.abort();
      translateAbort?.abort();
      loadToken++;
      translateToken++;
      set({
        track,
        phase: "idle",
        lyrics: null,
        providerId: null,
        errors: [],
        query: null,
        translateStatus: "idle",
        translatedLines: null,
        translateError: null,
      });
      if (track && attached > 0) void get().load();
    },

    async load(options = {}) {
      const { track, choice, query } = get();
      loadAbort?.abort();
      const token = ++loadToken;
      if (!track) {
        set({ phase: "idle", lyrics: null, providerId: null, errors: [] });
        return;
      }
      const providers = usePluginHost.getState().contributions.lyricsProviders;
      if (!providers.length) {
        set({ phase: "no-providers", lyrics: null, providerId: null, errors: [] });
        return;
      }
      const controller = new AbortController();
      loadAbort = controller;
      set({ phase: "loading", lyrics: null, providerId: null, errors: [], translatedLines: null, translateStatus: "idle", translateError: null });
      const lookup: Track = query
        ? { ...track, title: query.title, artists: query.artist ? [{ id: "search", name: query.artist }] : [] }
        : track;
      try {
        const found = await findLyrics(providers, lookup, {
          providerId: choice === "auto" ? undefined : choice,
          fresh: options.fresh,
          signal: controller.signal,
        });
        if (token !== loadToken) return;
        const errors = found.errors.map((e) => `${e.label}: ${e.message}`);
        set({
          lyrics: found.lyrics,
          providerId: found.providerId,
          errors,
          phase: found.lyrics ? "ready" : errors.length ? "error" : "none",
        });
        if (found.lyrics) void runTranslate();
      } catch (err) {
        if (token !== loadToken || (err instanceof DOMException && err.name === "AbortError")) return;
        set({ phase: "error", errors: [err instanceof Error ? err.message : String(err)] });
      }
    },

    setChoice(choice) {
      set({ choice });
      savePrefs({ choice });
      if (get().track) void get().load();
    },

    search(query, fresh) {
      set({ query });
      if (get().track) void get().load({ fresh: fresh ?? true });
    },

    setFontScale(scale) {
      const fontScale = clampScale(scale);
      set({ fontScale });
      savePrefs({ fontScale });
    },

    setKaraoke(karaoke) {
      set({ karaoke });
    },

    setTranslateOn(translateOn) {
      set({ translateOn });
      savePrefs({ translateOn });
      void runTranslate();
    },

    setTranslateLanguage(translateLanguage) {
      set({ translateLanguage });
      savePrefs({ translateLanguage });
      void runTranslate();
    },

    attach() {
      attached++;
      // Show lyrics for what is playing now, and pick up providers that arrive later.
      if (get().track && (get().phase === "idle" || get().phase === "no-providers")) void get().load();
      return () => {
        attached = Math.max(0, attached - 1);
      };
    },
  };
});

/** Wire the view to the player. Called from the plugin activate; safe to call again. */
export function startLyricsView(ctx: PluginContext): void {
  stopLyricsView();
  host = ctx;
  const prefs = readPrefs();
  const languages: readonly string[] = TRANSLATE_LANGUAGES;
  useLyricsView.setState({
    fontScale: clampScale(prefs.fontScale ?? 1),
    choice: prefs.choice ?? "auto",
    translateOn: prefs.translateOn === true,
    translateLanguage: prefs.translateLanguage && languages.includes(prefs.translateLanguage) ? prefs.translateLanguage : "English",
  });
  try {
    const state = ctx.player.getState();
    useLyricsView.setState({ isPlaying: state.isPlaying });
    useLyricsView.getState().setTrack(state.current);
  } catch {
    // The player may not exist yet at start-up; the first track event fills this in.
  }
  stops = [
    ctx.onNowPlaying((track) => useLyricsView.getState().setTrack(track)),
    ctx.onPlayback((event) => {
      if (event.kind === "play") useLyricsView.setState({ isPlaying: true });
      else if (event.kind === "pause" || event.kind === "ended") useLyricsView.setState({ isPlaying: false });
    }),
    // A translator that appears or disappears while lyrics are open changes what the page can offer.
    useLyricsTranslators.subscribe((s, prev) => {
      const view = useLyricsView.getState();
      if (s.translators.length !== prev.translators.length && view.translateOn && view.lyrics) view.setTranslateOn(true);
    }),
  ];
}

export function stopLyricsView(): void {
  for (const stop of stops) stop();
  stops = [];
  loadAbort?.abort();
  translateAbort?.abort();
  loadToken++;
  translateToken++;
  host = null;
  useLyricsView.setState({ karaoke: false });
}

/** The current playback position in seconds (0 when unknown). */
export function playbackPosition(): number {
  try {
    return host?.player.getState().position ?? 0;
  } catch {
    return 0;
  }
}

/** True when the plugin was granted control of the player, so lines can be tapped to seek. */
export function canControlPlayer(): boolean {
  return host?.can("player.control") === true;
}

export function seekTo(seconds: number): void {
  try {
    host?.player.seek(seconds);
  } catch {
    // Seeking needs player.control; without it the line is simply not tappable.
  }
}

export function playerControl(action: "toggle" | "next" | "previous"): void {
  try {
    if (action === "toggle") host?.player.toggle();
    else if (action === "next") void host?.player.next();
    else void host?.player.previous();
  } catch {
    // Not granted or the player is not ready.
  }
}
