import type { DjRequest } from "./prompt";
import { requestPicks } from "./providers";
import type { DjTrack } from "./resolve";
import { spotifySource, type DjMusicSource } from "./sources";
import type { TasteProfile } from "./tasteProfile";

export interface DjSetOptions extends Omit<DjRequest, "avoid" | "now"> {
  /** Tracks already played or queued this session. */
  history?: DjTrack[];
}

/**
 * Ask the model for a set and keep only the picks that exist in the music
 * source (Spotify unless told otherwise). Small models invent songs, so we
 * ask for a few more than we need. `provider` is a provider ref (see
 * providers.ts).
 */
export async function planDjSet(
  provider: string,
  profile: TasteProfile,
  opts: DjSetOptions = {},
  source: DjMusicSource = spotifySource,
): Promise<DjTrack[]> {
  const count = opts.count ?? 8;
  const history = opts.history ?? [];
  const picks = await requestPicks(provider, profile, {
    mood: opts.mood,
    switchUp: opts.switchUp,
    count: count + 3,
    avoid: history.map((h) => `${h.track.artists[0]?.name ?? ""} – ${h.track.title}`),
  });
  if (!picks.length) throw new Error("The DJ didn't suggest any songs. Try again.");
  const set = await source.resolve(picks, history.map((h) => h.track.id));
  if (!set.length) throw new Error(`None of the DJ's picks were found on ${source.label}. Try again or pick a bigger model.`);
  return set.slice(0, count);
}
