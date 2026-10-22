import { useHistory } from "@/features/history/historyStore";
import { primaryArtist } from "@/shared/types";
import type { Play } from "@uma/shared";
import type { TasteProfile } from "./tasteProfile";

const line = (p: Play) => `${primaryArtist(p.track)} – ${p.track.title}`;

function topBy(plays: Play[], key: (p: Play) => string, max: number): string[] {
  const counts = new Map<string, number>();
  for (const p of plays) {
    const k = key(p);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
}

/** A taste profile built only from what was played in this app (newest plays first). */
export function tasteFromPlays(plays: Play[]): TasteProfile {
  return {
    topArtists: topBy(plays, (p) => p.track.artists[0]?.name ?? "", 20),
    genres: [],
    topTracks: topBy(plays, line, 20),
    recentTracks: [...new Set(plays.slice(0, 40).map(line))].slice(0, 15),
  };
}

export function historyTaste(): TasteProfile {
  return tasteFromPlays(useHistory.getState().plays);
}
