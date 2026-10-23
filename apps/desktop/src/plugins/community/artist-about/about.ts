import { MetadataError, type MetadataClient } from "../_metadata/client";
import type { ArtistInfo, FanartInfo, WikiSummary } from "../_metadata/types";

export interface AboutData {
  name: string;
  image?: string;
  description?: string;
  extract?: string;
  genres: string[];
  facts: string[];
  links: { label: string; url: string }[];
  sources: string[];
}

const MAX_LINKS = 8;

const TYPE_LABEL: Record<string, string> = { Group: "Band", Person: "Artist", Orchestra: "Orchestra", Choir: "Choir", Character: "Character" };

/** "Band · United Kingdom · since 1985" from what MusicBrainz knows. */
export function factsFor(info: ArtistInfo | undefined, regionName: (code: string) => string | undefined = defaultRegionName): string[] {
  if (!info) return [];
  const facts: string[] = [];
  if (info.type) facts.push(TYPE_LABEL[info.type] ?? info.type);
  if (info.country) facts.push(regionName(info.country) ?? info.country);
  if (info.beginYear) facts.push("since " + info.beginYear);
  return facts;
}

function defaultRegionName(code: string): string | undefined {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code);
  } catch {
    return undefined;
  }
}

/** Merge what the three services said about one artist. Missing parts are simply left out. */
export function buildAbout(
  name: string,
  parts: { artist?: ArtistInfo; wiki?: WikiSummary; fanart?: FanartInfo },
  regionName?: (code: string) => string | undefined,
): AboutData | null {
  const { artist, wiki, fanart } = parts;
  if (!artist && !wiki && !fanart) return null;
  const links: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  const add = (label: string, url: string | undefined) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ label, url });
  };
  add("Wikipedia", wiki?.url);
  for (const link of artist?.links ?? []) add(link.label, link.url);
  const sources = [wiki && "Wikipedia", artist && "MusicBrainz", fanart && "Fanart.tv"].filter((s): s is string => !!s);
  return {
    name: artist?.name ?? wiki?.title ?? name,
    image: fanart?.thumbs[0] ?? wiki?.image,
    description: wiki?.description,
    extract: wiki?.extract,
    genres: artist?.genres ?? [],
    facts: factsFor(artist, regionName),
    links: links.slice(0, MAX_LINKS),
    sources,
  };
}

/** Load everything about an artist. Throws only when nothing could be found or a real problem occurred. */
export async function loadAbout(client: MetadataClient, name: string, signal?: AbortSignal): Promise<AboutData> {
  const [artist, wiki, fanart] = await Promise.allSettled([client.artist(name, signal), client.wikipedia(name, signal), client.fanart(name, signal)]);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const built = buildAbout(name, {
    artist: artist.status === "fulfilled" ? artist.value : undefined,
    wiki: wiki.status === "fulfilled" ? wiki.value : undefined,
    fanart: fanart.status === "fulfilled" ? fanart.value : undefined,
  });
  if (built) return built;
  // Fanart is optional, so its errors do not count. Report the most useful of the others.
  const errors = [artist, wiki].flatMap((r) => (r.status === "rejected" && r.reason instanceof MetadataError ? [r.reason] : []));
  const real = errors.find((e) => e.kind !== "not_found");
  throw real ?? new MetadataError("not_found", "Nothing found about this artist.");
}
