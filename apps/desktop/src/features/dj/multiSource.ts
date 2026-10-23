import type { Track } from "@/shared/types";
import { useJellyfin } from "@/plugins/builtins/jellyfin/jellyfinStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { useSpotify } from "@/plugins/builtins/spotify/spotifyStore";
import type { DjPick } from "./prompt";
import { normalize, resolvePick, trackMatchesPick, type DjTrack } from "./resolve";
import { jellyfinSource, spotifySource, type DjMusicSource } from "./sources";
import { historyTaste } from "./historyTaste";
import { isEmptyProfile, type TasteProfile } from "./tasteProfile";

// Looks songs the model named up in every place the listener can play from,
// the same "verify, never play made-up tracks" rule the DJ follows. The server
// library comes first (it is the listener's own music), then Jellyfin, then Spotify.

/** One place to find songs. `find` answers position by position: the track, or null if it isn't there. */
export interface Lookup {
  id: string;
  label: string;
  connected: () => boolean;
  find: (picks: { artist: string; title: string }[]) => Promise<(Track | null)[]>;
}

/** Match named songs against a list of tracks already in memory (the server library). */
export function matchInTracks(tracks: Track[], picks: { artist: string; title: string }[]): (Track | null)[] {
  if (!tracks.length) return picks.map(() => null);
  const byTitle = new Map<string, Track[]>();
  for (const t of tracks) {
    const key = normalize(t.title).slice(0, 12);
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(t);
    else byTitle.set(key, [t]);
  }
  return picks.map((pick) => {
    const bucket = byTitle.get(normalize(pick.title).slice(0, 12));
    return bucket?.find((t) => trackMatchesPick(t, pick)) ?? null;
  });
}

export const serverLookup: Lookup = {
  id: "server",
  label: "your server library",
  connected: () => !!useServer.getState().user && useServer.getState().tracks.length > 0,
  find: async (picks) => matchInTracks(useServer.getState().tracks, picks),
};

export const jellyfinLookup: Lookup = {
  id: "jellyfin",
  label: "Jellyfin",
  connected: jellyfinSource.connected,
  find: (picks) => useJellyfin.getState().match(picks),
};

export const spotifyLookup: Lookup = {
  id: "spotify",
  label: "Spotify",
  connected: () => useSpotify.getState().status === "signed-in",
  find: (picks) => Promise.all(picks.map((p) => resolvePick({ ...p, intro: "" }).catch(() => null))),
};

export const LOOKUPS: Lookup[] = [serverLookup, jellyfinLookup, spotifyLookup];

export interface Resolved<P extends { artist: string; title: string }> {
  pick: P;
  track: Track | null;
  /** Label of the place it was found, when it was. */
  via?: string;
}

export const connectedLookups = (lookups: Lookup[] = LOOKUPS) => lookups.filter((l) => l.connected());

/**
 * Resolve every pick: the first connected place that has the song wins; picks
 * still missing go to the next place. A place that errors is skipped.
 */
export async function resolveAcross<P extends { artist: string; title: string }>(
  picks: P[],
  lookups: Lookup[] = connectedLookups(),
): Promise<Resolved<P>[]> {
  const out: Resolved<P>[] = picks.map((pick) => ({ pick, track: null }));
  for (const lookup of lookups) {
    const missing = out.filter((r) => !r.track);
    if (!missing.length) break;
    let found: (Track | null)[];
    try {
      found = await lookup.find(missing.map((r) => r.pick));
    } catch {
      continue;
    }
    missing.forEach((r, i) => {
      const track = found[i];
      if (track) {
        r.track = track;
        r.via = lookup.label;
      }
    });
  }
  return out;
}

/** Drop repeats and anything in `avoid` (track ids), keeping order. */
export function uniqueResolved<P extends { artist: string; title: string }>(
  resolved: Resolved<P>[],
  avoid: Iterable<string> = [],
): Resolved<P>[] {
  const seen = new Set(avoid);
  return resolved.filter((r) => {
    if (!r.track || seen.has(r.track.id)) return false;
    seen.add(r.track.id);
    return true;
  });
}

/** Why there is nothing to resolve against, for empty states. */
export function noSourceMessage(): string {
  return "Connect your Cadence server, Jellyfin or Spotify so there is somewhere to find the songs.";
}

/**
 * Everything the listener can play from, as one source for the DJ's machinery
 * (planDjSet). Taste comes from listening history plus the connected services.
 */
export const everywhereSource: DjMusicSource = {
  id: "spotify", // unused: the radio never asks the DJ's source preference
  label: "your music",
  connected: () => connectedLookups().length > 0,
  async taste(): Promise<TasteProfile> {
    const fromHistory = historyTaste();
    const service = [jellyfinSource, spotifySource].find((s) => s.connected());
    if (!service) return fromHistory;
    try {
      const theirs = await service.taste();
      const merge = (a: string[], b: string[], max: number) => [...new Set([...a, ...b])].slice(0, max);
      return {
        topArtists: merge(fromHistory.topArtists, theirs.topArtists, 20),
        genres: theirs.genres,
        topTracks: merge(fromHistory.topTracks, theirs.topTracks, 20),
        recentTracks: merge(fromHistory.recentTracks, theirs.recentTracks, 15),
      };
    } catch {
      return fromHistory; // too little on the service; history (possibly empty) is still fine
    }
  },
  async resolve(picks: DjPick[], avoidIds: Iterable<string> = []): Promise<DjTrack[]> {
    const resolved = uniqueResolved(await resolveAcross(picks), avoidIds);
    return resolved.map((r) => ({ track: r.track!, intro: r.pick.intro }));
  },
};

export { isEmptyProfile };
