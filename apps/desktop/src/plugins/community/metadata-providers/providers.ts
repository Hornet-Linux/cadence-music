import type { MetadataProvider, TrackMetadata } from "../../types";
import type { Track } from "@/shared/types";
import type { MetadataClient } from "../_metadata/client";

const MAX_ABOUT = 1200;

const leadArtist = (track: Track): string | undefined => track.artists[0]?.name?.trim() || undefined;

/** The value of a settled promise, or undefined. A caller that aborted should stop, not get partial data. */
function value<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

function nothingIfEmpty(meta: TrackMetadata): TrackMetadata | null {
  const has = meta.artwork || meta.about || meta.year || (meta.genres && meta.genres.length > 0) || (meta.links && meta.links.length > 0);
  return has ? meta : null;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/** Album cover (Cover Art Archive), year, genres and links from MusicBrainz. */
export function musicBrainzProvider(client: MetadataClient): MetadataProvider {
  return {
    id: "musicbrainz",
    label: "MusicBrainz and Cover Art Archive",
    async getMetadata(track, signal) {
      const artist = leadArtist(track);
      if (!artist) return null;
      const [recording, artistInfo, cover] = await Promise.allSettled([
        client.recording(track.title, artist, signal),
        client.artist(artist, signal),
        track.album ? client.cover(track.album, artist, signal) : Promise.reject(new Error("no album")),
      ]);
      throwIfAborted(signal);
      const rec = value(recording);
      const info = value(artistInfo);
      const genres = rec && rec.genres.length > 0 ? rec.genres : (info?.genres ?? []);
      return nothingIfEmpty({
        artwork: value(cover)?.url,
        year: rec?.year,
        genres: genres.length > 0 ? genres : undefined,
        links: info?.links.length ? info.links : undefined,
      });
    },
  };
}

/** The artist biography from Wikipedia (found through MusicBrainz and Wikidata). */
export function wikipediaProvider(client: MetadataClient): MetadataProvider {
  return {
    id: "wikipedia",
    label: "Wikipedia",
    async getMetadata(track, signal) {
      const artist = leadArtist(track);
      if (!artist) return null;
      const wiki = await client.wikipedia(artist, signal).catch((err: unknown) => {
        if (signal?.aborted) throw err;
        return null;
      });
      if (!wiki) return null;
      return nothingIfEmpty({
        about: wiki.extract.length > MAX_ABOUT ? wiki.extract.slice(0, MAX_ABOUT).trimEnd() + "..." : wiki.extract,
        links: wiki.url ? [{ label: "Wikipedia", url: wiki.url }] : undefined,
      });
    },
  };
}

/** Optional: the Discogs artist profile and release details, when the server admin added a Discogs token. */
export function discogsProvider(client: MetadataClient): MetadataProvider {
  return {
    id: "discogs",
    label: "Discogs",
    async getMetadata(track, signal) {
      const artist = leadArtist(track);
      if (!artist) return null;
      const [profile, release] = await Promise.allSettled([
        client.discogs(artist, signal),
        track.album ? client.discogsRelease(artist, track.album, signal) : Promise.reject(new Error("no album")),
      ]);
      throwIfAborted(signal);
      const p = value(profile);
      const r = value(release)?.items[0];
      const genres = r ? [...r.genres, ...r.styles] : [];
      const links = [...(p?.url ? [{ label: "Discogs", url: p.url }] : []), ...(p?.links ?? [])];
      return nothingIfEmpty({
        about: p?.profile ? p.profile.slice(0, MAX_ABOUT) : undefined,
        year: r?.year,
        genres: genres.length > 0 ? genres.slice(0, 6) : undefined,
        links: links.length > 0 ? links : undefined,
      });
    },
  };
}
