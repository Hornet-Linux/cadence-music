import { useJellyfin } from "@/plugins/builtins/jellyfin/jellyfinStore";
import { useSpotify } from "@/plugins/builtins/spotify/spotifyStore";
import type { DjPick } from "./prompt";
import { resolvePicks, type DjTrack } from "./resolve";
import { buildTasteProfile, isEmptyProfile, type TasteProfile } from "./tasteProfile";

export type DjSourceId = "spotify" | "jellyfin";
/** Settings → AI DJ → "DJ plays from". */
export type DjSourcePref = "auto" | DjSourceId;

/** Where the DJ learns the listener's taste and finds the songs it picks. */
export interface DjMusicSource {
  id: DjSourceId;
  label: string;
  connected: () => boolean;
  /** Listening history and favourites; throws a friendly error when there is too little to go on. */
  taste: () => Promise<TasteProfile>;
  /** The picks that really exist in this source, without duplicates or anything in `avoidIds` (track ids). */
  resolve: (picks: DjPick[], avoidIds?: Iterable<string>) => Promise<DjTrack[]>;
}

export const spotifySource: DjMusicSource = {
  id: "spotify",
  label: "Spotify",
  connected: () => useSpotify.getState().status === "signed-in",
  async taste() {
    const profile = await buildTasteProfile(useSpotify.getState().tracks);
    if (isEmptyProfile(profile)) throw new Error("Play or like a few songs on Spotify first so the DJ knows your taste.");
    return profile;
  },
  resolve: (picks, avoidIds) => resolvePicks(picks, avoidIds),
};

export const jellyfinSource: DjMusicSource = {
  id: "jellyfin",
  label: "Jellyfin",
  connected: () => useJellyfin.getState().status?.connected === true,
  async taste() {
    const profile = await useJellyfin.getState().taste();
    if (isEmptyProfile(profile)) {
      throw new Error("Play or favourite a few songs in Jellyfin first so the DJ knows your taste.");
    }
    return profile;
  },
  async resolve(picks, avoidIds = []) {
    const matches = await useJellyfin.getState().match(picks.map(({ artist, title }) => ({ artist, title })));
    const seen = new Set(avoidIds);
    const out: DjTrack[] = [];
    matches.forEach((track, i) => {
      if (!track || seen.has(track.id)) return;
      seen.add(track.id);
      out.push({ track, intro: picks[i].intro });
    });
    return out;
  },
};

export const DJ_SOURCES: DjMusicSource[] = [jellyfinSource, spotifySource];

const PREF_KEY = "dj:source";

export function loadSourcePref(): DjSourcePref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "spotify" || v === "jellyfin" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function saveSourcePref(pref: DjSourcePref): void {
  try {
    localStorage.setItem(PREF_KEY, pref);
  } catch {
    // Storage is optional.
  }
}

/**
 * The source the DJ plays from: the chosen one if it is connected. "Auto"
 * prefers Jellyfin when it is connected, otherwise Spotify.
 */
export function chooseDjSource(pref: DjSourcePref, sources: DjMusicSource[] = DJ_SOURCES): DjMusicSource | null {
  if (pref !== "auto") return sources.find((s) => s.id === pref && s.connected()) ?? null;
  return sources.find((s) => s.connected()) ?? null;
}

/** What to tell the listener when `chooseDjSource` found nothing. */
export function connectSourceMessage(pref: DjSourcePref, sources: DjMusicSource[] = DJ_SOURCES): string {
  if (pref === "auto") return `Connect ${[...sources].reverse().map((s) => s.label).join(" or ")} to use the DJ.`;
  const label = sources.find((s) => s.id === pref)?.label ?? pref;
  return `Connect ${label} to use the DJ, or pick another source in Settings → AI DJ.`;
}

/** True when at least one music source is connected (React hook, for showing the DJ card). */
export function useAnyDjSource(): boolean {
  const spotify = useSpotify((s) => s.status === "signed-in");
  const jellyfin = useJellyfin((s) => s.status?.connected === true);
  return spotify || jellyfin;
}
