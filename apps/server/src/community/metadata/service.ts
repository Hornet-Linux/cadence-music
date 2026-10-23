import { UpstreamError } from "./errors.js";
import {
  bandsintownName,
  looksLikeMusicArtist,
  luceneQuoted,
  mapArtist,
  mapCover,
  mapDiscogsArtist,
  mapDiscogsReleases,
  mapEvents,
  mapFanart,
  mapRecording,
  mapRelease,
  mapReleaseGroups,
  mapWikiSummary,
  MBID_RE,
  pickArtist,
  pickDiscogsArtist,
  pickRecording,
  pickRelease,
  wikidataTitle,
  type ArtistInfo,
  type ConcertInfo,
  type CoverInfo,
  type DiscogsArtist,
  type DiscogsRelease,
  type FanartInfo,
  type RecordingInfo,
  type ReleaseGroupInfo,
  type ReleaseInfo,
  type WikiSummary,
} from "./mapping.js";
import { PROVIDERS, type ProviderId, type Upstream } from "./upstream.js";

/** What the admin can configure for this plugin (saved in the server settings). */
export interface MetadataConfig {
  fanartApiKey?: string;
  discogsToken?: string;
  /** The app id Bandsintown issued for this server. */
  bandsintownAppId?: string;
  /** Replace a service address (a mirror, or a fake service when testing). */
  baseUrls?: Partial<Record<ProviderId, string>>;
}

const q = encodeURIComponent;
/** New releases change daily, so they are cached for hours, not days. */
const NEW_RELEASES_TTL_MS = 12 * 3_600_000;

/** The lookups behind the /api/metadata routes. Each returns a small normalised shape or throws UpstreamError. */
export class MetadataService {
  constructor(
    private readonly upstream: Upstream,
    private readonly getConfig: () => MetadataConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private base(provider: ProviderId): string {
    const custom = this.getConfig().baseUrls?.[provider];
    return (custom || PROVIDERS[provider].base).replace(/\/+$/, "");
  }

  status(): Record<ProviderId, boolean> {
    const c = this.getConfig();
    return {
      musicbrainz: true,
      coverart: true,
      wikipedia: true,
      wikidata: true,
      fanart: !!c.fanartApiKey,
      discogs: !!c.discogsToken,
      bandsintown: !!c.bandsintownAppId,
    };
  }

  private mb<T>(path: string, ttlMs?: number) {
    const sep = path.includes("?") ? "&" : "?";
    return this.upstream.getJson<T>("musicbrainz", this.base("musicbrainz") + "/ws/2/" + path + sep + "fmt=json", ttlMs ? { ttlMs } : {});
  }

  // ---- MusicBrainz ----

  async findArtistMbid(name: string): Promise<string> {
    const query = "artist:" + luceneQuoted(name);
    const { data } = await this.mb("artist?query=" + q(query) + "&limit=5");
    const hit = pickArtist(data, name);
    if (!hit) throw new UpstreamError("not_found", "musicbrainz");
    return hit.mbid;
  }

  async artist(by: { mbid?: string; name?: string }): Promise<ArtistInfo> {
    const mbid = by.mbid ?? (await this.findArtistMbid(by.name ?? ""));
    const { data } = await this.mb("artist/" + mbid + "?inc=genres+url-rels");
    const mapped = mapArtist(data);
    if (!mapped) throw new UpstreamError("bad_response", "musicbrainz");
    return mapped;
  }

  async recording(by: { mbid?: string; title?: string; artist?: string }): Promise<RecordingInfo> {
    if (by.mbid) {
      const { data } = await this.mb("recording/" + by.mbid + "?inc=artists+releases+genres");
      const mapped = mapRecording(data);
      if (!mapped) throw new UpstreamError("bad_response", "musicbrainz");
      return mapped;
    }
    let query = "recording:" + luceneQuoted(by.title ?? "");
    if (by.artist) query += " AND artist:" + luceneQuoted(by.artist);
    const { data } = await this.mb("recording?query=" + q(query) + "&limit=5");
    const hit = pickRecording(data);
    if (!hit) throw new UpstreamError("not_found", "musicbrainz");
    return hit;
  }

  async release(by: { mbid?: string; album?: string; artist?: string }): Promise<ReleaseInfo> {
    if (by.mbid) {
      const { data } = await this.mb("release/" + by.mbid + "?inc=artists+release-groups+genres");
      const mapped = mapRelease(data);
      if (!mapped) throw new UpstreamError("bad_response", "musicbrainz");
      return mapped;
    }
    let query = "release:" + luceneQuoted(by.album ?? "");
    if (by.artist) query += " AND artist:" + luceneQuoted(by.artist);
    const { data } = await this.mb("release?query=" + q(query) + "&limit=5");
    const hit = pickRelease(data);
    if (!hit) throw new UpstreamError("not_found", "musicbrainz");
    return hit;
  }

  /** Release groups an artist first released in the last `days` days. */
  async newReleases(artist: string, days: number): Promise<ReleaseGroupInfo[]> {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const to = this.now();
    const from = to - days * 86_400_000;
    const query = "artist:" + luceneQuoted(artist) + " AND firstreleasedate:[" + day(from) + " TO " + day(to) + "]";
    const { data } = await this.mb("release-group?query=" + q(query) + "&limit=40", NEW_RELEASES_TTL_MS);
    return mapReleaseGroups(data, artist);
  }

  // ---- Cover Art Archive ----

  async cover(by: { release?: string; releaseGroup?: string; album?: string; artist?: string }): Promise<CoverInfo> {
    let kind: CoverInfo["kind"] = "release";
    let mbid = by.release;
    if (!mbid && by.releaseGroup) {
      kind = "release-group";
      mbid = by.releaseGroup;
    }
    if (!mbid) {
      let query = "releasegroup:" + luceneQuoted(by.album ?? "");
      if (by.artist) query += " AND artist:" + luceneQuoted(by.artist);
      const { data } = await this.mb<{ "release-groups"?: { id?: string; score?: number }[] }>("release-group?query=" + q(query) + "&limit=3");
      const hit = data["release-groups"]?.find((g) => (g.score ?? 0) >= 85 && g.id && MBID_RE.test(g.id));
      if (!hit?.id) throw new UpstreamError("not_found", "musicbrainz");
      kind = "release-group";
      mbid = hit.id;
    }
    const { data } = await this.upstream.getJson("coverart", this.base("coverart") + "/" + kind + "/" + mbid);
    const mapped = mapCover(data, mbid, kind);
    if (!mapped) throw new UpstreamError("not_found", "coverart");
    return mapped;
  }

  // ---- Wikipedia and Wikidata ----

  private async summary(lang: string, title: string): Promise<WikiSummary | null> {
    const customBase = this.getConfig().baseUrls?.wikipedia;
    const base = customBase ? customBase.replace(/\/+$/, "") : "https://" + lang + ".wikipedia.org";
    try {
      const { data } = await this.upstream.getJson("wikipedia", base + "/api/rest_v1/page/summary/" + q(title.replace(/ /g, "_")));
      return mapWikiSummary(data);
    } catch (err) {
      if (err instanceof UpstreamError && err.kind === "not_found") return null;
      throw err;
    }
  }

  async wikipedia(by: { name?: string; mbid?: string; lang: string }): Promise<WikiSummary & { wikidataId?: string; lang: string }> {
    let wikidataId: string | undefined;
    try {
      const artist = await this.artist({ mbid: by.mbid, name: by.name });
      wikidataId = artist.wikidataId;
    } catch (err) {
      if (!(err instanceof UpstreamError) || err.kind !== "not_found") throw err;
    }
    if (wikidataId) {
      const site = by.lang + "wiki";
      const url = this.base("wikidata") + "/w/api.php?action=wbgetentities&ids=" + wikidataId + "&props=sitelinks&sitefilter=" + site + "&format=json";
      const { data } = await this.upstream.getJson("wikidata", url);
      const title = wikidataTitle(data, wikidataId, site);
      const summary = title ? await this.summary(by.lang, title) : null;
      if (summary && !summary.disambiguation) return { ...summary, wikidataId, lang: by.lang };
    }
    // No linked page: try the usual titles for a musician and keep the first that reads like one.
    if (by.name) {
      for (const title of [by.name + " (band)", by.name + " (musician)", by.name + " (singer)", by.name]) {
        const summary = await this.summary(by.lang, title);
        if (summary && looksLikeMusicArtist(summary)) return { ...summary, wikidataId, lang: by.lang };
      }
    }
    throw new UpstreamError("not_found", "wikipedia");
  }

  // ---- Fanart.tv ----

  async fanart(by: { mbid?: string; name?: string }): Promise<FanartInfo> {
    const key = this.getConfig().fanartApiKey;
    if (!key) throw new UpstreamError("not_configured", "Fanart.tv");
    const mbid = by.mbid ?? (await this.findArtistMbid(by.name ?? ""));
    const { data } = await this.upstream.getJson("fanart", this.base("fanart") + "/v3/music/" + mbid, { headers: { "api-key": key } });
    const mapped = mapFanart(data);
    if (!mapped) throw new UpstreamError("not_found", "fanart");
    return mapped;
  }

  // ---- Discogs ----

  private discogsHeaders(): Record<string, string> {
    const token = this.getConfig().discogsToken;
    if (!token) throw new UpstreamError("not_configured", "Discogs");
    return { authorization: "Discogs token=" + token };
  }

  async discogsArtist(name: string): Promise<DiscogsArtist> {
    const headers = this.discogsHeaders();
    const base = this.base("discogs");
    const { data: search } = await this.upstream.getJson("discogs", base + "/database/search?type=artist&per_page=5&q=" + q(name), { headers });
    const id = pickDiscogsArtist(search, name);
    if (id === null) throw new UpstreamError("not_found", "discogs");
    const { data } = await this.upstream.getJson("discogs", base + "/artists/" + id, { headers });
    const mapped = mapDiscogsArtist(data);
    if (!mapped) throw new UpstreamError("bad_response", "discogs");
    return mapped;
  }

  async discogsReleases(artist: string, title: string): Promise<DiscogsRelease[]> {
    const headers = this.discogsHeaders();
    const url = this.base("discogs") + "/database/search?type=release&per_page=5&artist=" + q(artist) + "&release_title=" + q(title);
    const { data } = await this.upstream.getJson("discogs", url, { headers });
    const mapped = mapDiscogsReleases(data);
    if (mapped.length === 0) throw new UpstreamError("not_found", "discogs");
    return mapped;
  }

  // ---- Bandsintown ----

  async events(artist: string): Promise<ConcertInfo[]> {
    const appId = this.getConfig().bandsintownAppId;
    if (!appId) throw new UpstreamError("not_configured", "Bandsintown");
    try {
      const url = this.base("bandsintown") + "/artists/" + bandsintownName(artist) + "/events?app_id=" + q(appId) + "&date=upcoming";
      const { data } = await this.upstream.getJson("bandsintown", url);
      return mapEvents(data, artist);
    } catch (err) {
      // An artist the service has never heard of simply has no shows.
      if (err instanceof UpstreamError && err.kind === "not_found") return [];
      throw err;
    }
  }
}
