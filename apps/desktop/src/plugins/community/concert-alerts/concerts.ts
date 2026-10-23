import { MetadataError, mapLimit, type MetadataClient } from "../_metadata/client";
import type { RankedArtist } from "../_metadata/artists";
import type { ConcertInfo } from "../_metadata/types";

export interface Location {
  city: string;
  country?: string;
}

/** "Paris" or "Paris, France" (the part after the comma narrows by country). */
export function parseLocation(input: string): Location | null {
  const parts = input
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts[0].length > 80) return null;
  const country = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return { city: parts[0], country: country && country.length <= 60 ? country : undefined };
}

export const locationText = (loc: Location) => (loc.country ? loc.city + ", " + loc.country : loc.city);

/** The start of a show as a Date. Bandsintown gives local venue time without a zone. */
export function showDate(datetime: string): Date | null {
  const d = new Date(datetime);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Shows that have not happened yet, soonest first, one row per artist and day and venue. */
export function upcomingShows(events: ConcertInfo[], now: number, limit = 12): ConcertInfo[] {
  const seen = new Set<string>();
  const out: { show: ConcertInfo; at: number }[] = [];
  for (const show of events) {
    const at = showDate(show.datetime)?.getTime();
    // Shows earlier today still count until the day is over.
    if (at === undefined || at < now - 6 * 3_600_000) continue;
    const key = [show.artist.toLowerCase(), show.datetime.slice(0, 10), show.venue.toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ show, at });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, limit).map((x) => x.show);
}

export interface ConcertResult {
  shows: ConcertInfo[];
  checked: number;
  failed: number;
  notConfigured: boolean;
}

/** Look up shows near `loc` for each artist, a few at a time, reporting as results arrive. */
export async function findConcerts(
  client: MetadataClient,
  artists: RankedArtist[],
  loc: Location,
  options: { now?: number; signal?: AbortSignal; onProgress?: (result: ConcertResult) => void } = {},
): Promise<ConcertResult> {
  const now = options.now ?? Date.now();
  const all: ConcertInfo[] = [];
  let checked = 0;
  let failed = 0;
  let notConfigured = false;
  const snapshot = (): ConcertResult => ({ shows: upcomingShows(all, now), checked, failed, notConfigured });
  await mapLimit(
    artists,
    3,
    async (artist) => {
      try {
        const res = await client.events(artist.name, loc.city, loc.country, options.signal);
        all.push(...res.items);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (err instanceof MetadataError && err.kind === "not_configured") notConfigured = true;
        else if (!(err instanceof MetadataError && err.kind === "not_found")) failed += 1;
      } finally {
        checked += 1;
        options.onProgress?.(snapshot());
      }
    },
    () => notConfigured || options.signal?.aborted === true,
  );
  return snapshot();
}
