import { MetadataError, mapLimit, type MetadataClient } from "../_metadata/client";
import type { RankedArtist } from "../_metadata/artists";
import type { ReleaseGroupInfo } from "../_metadata/types";

export const WINDOW_DAYS = 90;
const MAX_SHOWN = 12;

export interface ReleasesResult {
  items: ReleaseGroupInfo[];
  checked: number;
  failed: number;
}

/** One row per release (the same release can come back under several credits), newest first. */
export function mergeReleases(groups: ReleaseGroupInfo[][], now: number, days = WINDOW_DAYS): ReleaseGroupInfo[] {
  const earliest = now - days * 86_400_000;
  const seen = new Set<string>();
  const out: ReleaseGroupInfo[] = [];
  for (const group of groups.flat()) {
    const at = Date.parse(group.date.length <= 7 ? group.date + "-01" : group.date);
    // MusicBrainz dates can be just a year or a month; those are too vague to call "new".
    if (!Number.isFinite(at) || group.date.length < 10 || at < earliest || at > now + 7 * 86_400_000) continue;
    const keys = [group.mbid, (group.artist + "|" + group.title).toLowerCase()];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(group);
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export const withoutDismissed = (items: ReleaseGroupInfo[], dismissed: string[]) =>
  items.filter((i) => !dismissed.includes(i.mbid)).slice(0, MAX_SHOWN);

/** Ask for each artist in turn (a few at a time) and report what has been found so far. */
export async function findNewReleases(
  client: MetadataClient,
  artists: RankedArtist[],
  options: { now?: number; days?: number; signal?: AbortSignal; onProgress?: (result: ReleasesResult) => void } = {},
): Promise<ReleasesResult> {
  const now = options.now ?? Date.now();
  const days = options.days ?? WINDOW_DAYS;
  const groups: ReleaseGroupInfo[][] = [];
  let checked = 0;
  let failed = 0;
  const snapshot = (): ReleasesResult => ({ items: mergeReleases(groups, now, days), checked, failed });
  await mapLimit(
    artists,
    2,
    async (artist) => {
      try {
        groups.push((await client.newReleases(artist.name, days, options.signal)).items);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (!(err instanceof MetadataError && err.kind === "not_found")) failed += 1;
      } finally {
        checked += 1;
        options.onProgress?.(snapshot());
      }
    },
    () => options.signal?.aborted === true,
  );
  return snapshot();
}

/** Remembered results, so Home does not repeat the lookups on every visit. */
export interface StoredReleases {
  key: string;
  at: number;
  items: ReleaseGroupInfo[];
}

export const CACHE_MS = 6 * 3_600_000;

export const isFresh = (stored: StoredReleases | null, key: string, now: number): stored is StoredReleases =>
  !!stored && stored.key === key && now - stored.at < CACHE_MS && Array.isArray(stored.items);
