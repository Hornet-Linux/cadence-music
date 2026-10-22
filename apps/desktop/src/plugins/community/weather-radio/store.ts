import { create } from "zustand";
import { currentOption, requestPicks, useProviders } from "@/features/dj/providers";
import { useServer } from "@/plugins/builtins/server/serverStore";
import type { PluginStorage } from "@/plugins/types";
import type { Track } from "@/shared/types";
import { serverApi } from "../_social/serverApi";
import { forecastUrl, MOODS, moodFor, moodForTime, parseForecast, roundCoord, validCoords, type Forecast, type Mood, type MoodId } from "./mood";
import { buildStation, matchPicks, topLibraryArtists, type Station, type TrackTags } from "./radio";

const SETTINGS_KEY = "settings";
const WEATHER_MAX_AGE = 30 * 60_000;

export interface RadioSettings {
  /** "off": nothing chosen yet. "time": time of day only, no network. "weather": forecast from Open-Meteo. */
  mode: "off" | "time" | "weather";
  lat?: number;
  lon?: number;
  useAi: boolean;
  /** Extra words per mood, comma separated. */
  keywords: Partial<Record<MoodId, string>>;
}

const defaults: RadioSettings = { mode: "off", useAi: false, keywords: {} };

interface RadioState extends RadioSettings {
  loaded: boolean;
  weather: Forecast | null;
  fetchedAt: number;
  status: "idle" | "loading" | "error";
  error: string | null;
  station: Station | null;
  stationMood: Mood | null;
  note: string | null;
  building: boolean;
  tags: Record<string, TrackTags>;
  tagsPending: number | null;
  tagsAvailable: boolean | null;

  load: () => void;
  setMode: (mode: RadioSettings["mode"]) => void;
  setLocation: (lat: number, lon: number) => boolean;
  forgetLocation: () => void;
  setUseAi: (on: boolean) => void;
  setKeywords: (mood: MoodId, words: string) => void;
  refreshWeather: (force?: boolean) => Promise<void>;
  loadTags: () => Promise<void>;
  currentMood: () => Mood | null;
  makeStation: (library: Track[], size?: number) => Promise<void>;
}

let fetchFn: typeof fetch | null = null;
let storage: PluginStorage | null = null;
let playFn: ((tracks: Track[], index: number) => Promise<void>) | null = null;

export function attach(api: { fetch: typeof fetch; storage: PluginStorage; play: (tracks: Track[], index: number) => Promise<void> }): void {
  fetchFn = api.fetch;
  storage = api.storage;
  playFn = api.play;
}

export const playStation = (tracks: Track[]) => playFn?.(tracks, 0) ?? Promise.resolve();

export const keywordList = (words: string | undefined): string[] =>
  (words ?? "")
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 20);

export const useRadio = create<RadioState>((set, get) => {
  const save = () => {
    const { mode, lat, lon, useAi, keywords } = get();
    try {
      storage?.set(SETTINGS_KEY, { mode, lat, lon, useAi, keywords });
    } catch {
      // Storage unavailable: the choice lasts for this session.
    }
  };

  return {
    ...defaults,
    loaded: false,
    weather: null,
    fetchedAt: 0,
    status: "idle",
    error: null,
    station: null,
    stationMood: null,
    note: null,
    building: false,
    tags: {},
    tagsPending: null,
    tagsAvailable: null,

    load() {
      if (get().loaded) return;
      let saved: Partial<RadioSettings> | null = null;
      try {
        saved = storage?.get<Partial<RadioSettings>>(SETTINGS_KEY) ?? null;
      } catch {
        saved = null;
      }
      const lat = typeof saved?.lat === "number" ? saved.lat : undefined;
      const lon = typeof saved?.lon === "number" ? saved.lon : undefined;
      const hasPlace = lat !== undefined && lon !== undefined && validCoords(lat, lon);
      const mode = saved?.mode === "weather" && hasPlace ? "weather" : saved?.mode === "time" ? "time" : "off";
      set({ loaded: true, mode, lat: hasPlace ? lat : undefined, lon: hasPlace ? lon : undefined, useAi: !!saved?.useAi, keywords: saved?.keywords ?? {} });
    },

    setMode(mode) {
      set({ mode, error: null });
      save();
      if (mode === "weather") void get().refreshWeather(true);
    },

    setLocation(lat, lon) {
      if (!validCoords(lat, lon)) {
        set({ error: "Those coordinates aren't valid. Latitude is -90 to 90 and longitude -180 to 180." });
        return false;
      }
      set({ lat: roundCoord(lat), lon: roundCoord(lon), mode: "weather", error: null, weather: null });
      save();
      void get().refreshWeather(true);
      return true;
    },

    forgetLocation() {
      set({ lat: undefined, lon: undefined, mode: "off", weather: null, fetchedAt: 0, station: null, error: null });
      save();
    },

    setUseAi(useAi) {
      set({ useAi });
      save();
    },

    setKeywords(mood, words) {
      set({ keywords: { ...get().keywords, [mood]: words } });
      save();
    },

    async refreshWeather(force = false) {
      const { mode, lat, lon, fetchedAt, status } = get();
      if (mode !== "weather" || lat === undefined || lon === undefined || !fetchFn || status === "loading") return;
      if (!force && Date.now() - fetchedAt < WEATHER_MAX_AGE) return;
      set({ status: "loading", error: null });
      try {
        // The one request that leaves the device about weather: rounded coordinates to Open-Meteo.
        const res = await fetchFn(forecastUrl(lat, lon), { credentials: "omit", referrerPolicy: "no-referrer" });
        if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
        const forecast = parseForecast(await res.json());
        if (!forecast) throw new Error("Open-Meteo sent something unexpected");
        set({ weather: forecast, fetchedAt: Date.now(), status: "idle" });
      } catch (err) {
        set({ status: "error", error: `Couldn't get the weather (${err instanceof Error ? err.message : String(err)}). Using the time of day instead.` });
      }
    },

    async loadTags() {
      if (!useServer.getState().user) return set({ tags: {}, tagsAvailable: null });
      try {
        const res = await serverApi<{ items: { id: string; genres: string[]; bpm?: number }[]; pending: number }>("api/weather-radio/tags");
        const tags: Record<string, TrackTags> = {};
        for (const item of res.items) tags[`server:${item.id}`] = { genres: item.genres, bpm: item.bpm };
        set({ tags, tagsPending: res.pending, tagsAvailable: true });
      } catch {
        // The server plugin isn't enabled (or the server is older): matching falls back to words.
        set({ tags: {}, tagsAvailable: false });
      }
    },

    currentMood() {
      const { mode, weather } = get();
      if (mode === "off") return null;
      const hour = new Date().getHours();
      if (mode === "weather" && weather) return moodFor(weather);
      return moodForTime(hour);
    },

    async makeStation(library, size = 25) {
      const mood = get().currentMood();
      if (!mood || get().building) return;
      set({ building: true, note: null });
      try {
        const extra = keywordList(get().keywords[mood.id]);
        const avoid = new Set(get().station?.queue.map((t) => t.id) ?? []);
        let station = buildStation(library, get().tags, mood, { size, extraKeywords: extra, avoid });
        let note: string | null = null;
        const option = get().useAi ? currentOption() : undefined;
        if (get().useAi && option) {
          try {
            const picks = await requestPicks(option.ref, { topArtists: topLibraryArtists(library), genres: mood.genres.slice(0, 5), topTracks: [], recentTracks: [] }, { mood: mood.prompt, count: 24 });
            const owned = matchPicks(picks, library);
            if (owned.length > 0) {
              const ids = new Set(owned.map((t) => t.id));
              const queue = [...owned, ...station.queue.filter((t) => !ids.has(t.id))].slice(0, size);
              station = { ...station, queue, matched: Math.min(queue.length, station.matched + owned.length), filler: Math.max(0, queue.length - station.matched - owned.length) };
              note = `${option.name} suggested ${picks.length} songs; ${owned.length} are in your library and lead the queue.`;
            } else {
              note = `${option.name} didn't suggest anything you own, so the queue uses your library's tags and words.`;
            }
          } catch (err) {
            note = `The AI DJ couldn't help this time (${err instanceof Error ? err.message : String(err)}). Used your library's tags and words instead.`;
          }
        }
        set({ station, stationMood: mood, note });
      } finally {
        set({ building: false });
      }
    },
  };
});

/** Refresh the AI provider list so we know if the AI DJ is configured. */
export function refreshProviders(): void {
  void useProviders.getState().refreshRemote();
}

export { MOODS };