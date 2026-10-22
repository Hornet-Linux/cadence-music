import { useMemo } from "react";
import type { Play } from "@uma/shared";
import { useHistory } from "@/features/history/historyStore";
import type { Track } from "@/shared/types";
import { useServer } from "../../builtins/server/serverStore";

export interface RankedArtist {
  name: string;
  plays: number;
}

const SKIP = new Set(["unknown artist", "various artists", "unknown", "va", "[unknown]"]);

function usable(name: string | undefined): name is string {
  const n = name?.trim();
  return !!n && !SKIP.has(n.toLowerCase());
}

/**
 * The artists a person listens to most: history plays count fully, library tracks count a little
 * (so someone with no history yet still gets their library artists). Ties keep first-seen order.
 */
export function rankArtists(plays: Play[], library: Track[], limit: number): RankedArtist[] {
  const counts = new Map<string, RankedArtist>();
  const add = (name: string | undefined, weight: number) => {
    if (!usable(name)) return;
    const key = name.trim().toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.plays += weight;
    else counts.set(key, { name: name.trim(), plays: weight });
  };
  for (const play of plays) for (const artist of play.track.artists) add(artist.name, 1);
  for (const track of library) for (const artist of track.artists) add(artist.name, 0.01);
  return [...counts.values()].sort((a, b) => b.plays - a.plays).slice(0, limit);
}

/** Top artists from this device plus the server history, and the server library as a fallback. */
export function useTopArtists(limit: number): RankedArtist[] {
  const plays = useHistory((s) => s.plays);
  const library = useServer((s) => s.tracks);
  return useMemo(() => rankArtists(plays, library, limit), [plays, library, limit]);
}

/** A stable text key for a list of artists, used to know when cached results are out of date. */
export const artistsKey = (artists: RankedArtist[]) => artists.map((a) => a.name.toLowerCase()).join("|");
