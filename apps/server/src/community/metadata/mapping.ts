// Turns the answers of third-party services into small, stable shapes for the app.
// Everything here is defensive: upstream JSON is untrusted and may be missing fields.

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only ever hand the app web addresses it can safely open, and upgrade plain http. */
export function httpsUrl(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol === "http:") u.protocol = "https:";
    return u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Escape text for use inside a quoted Lucene phrase (MusicBrainz search syntax). */
export function luceneQuoted(text: string): string {
  return `"${text.replace(/[\\"]/g, "\\$&")}"`;
}

export function yearOf(date: unknown): number | undefined {
  const m = /^(\d{4})/.exec(str(date) ?? "");
  return m ? Number(m[1]) : undefined;
}

function creditName(credit: unknown): string {
  return arr(credit)
    .map((c) => {
      const o = obj(c);
      const join = typeof o.joinphrase === "string" ? o.joinphrase : "";
      return (str(o.name) ?? str(obj(o.artist).name) ?? "") + join;
    })
    .join("")
    .trim();
}

function creditArtistId(credit: unknown): string | undefined {
  return str(obj(obj(arr(credit)[0]).artist).id);
}

function genreNames(o: Json): string[] {
  const list = arr(o.genres).length > 0 ? arr(o.genres) : arr(o.tags);
  return list
    .map((g) => ({ name: str(obj(g).name), count: num(obj(g).count) ?? 0 }))
    .filter((g): g is { name: string; count: number } => !!g.name)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((g) => g.name);
}

export interface ArtistHit {
  mbid: string;
  name: string;
  score: number;
}

/** Choose the artist a name most likely means: an exact (case-insensitive) match first, else a confident top hit. */
export function pickArtist(search: unknown, name: string): ArtistHit | null {
  const hits = arr(obj(search).artists)
    .map((a) => ({ mbid: str(obj(a).id), name: str(obj(a).name), score: num(obj(a).score) ?? 0 }))
    .filter((a): a is ArtistHit => !!a.mbid && !!a.name && MBID_RE.test(a.mbid));
  const wanted = name.trim().toLowerCase();
  const exact = hits.find((h) => h.name.toLowerCase() === wanted && h.score >= 80);
  if (exact) return exact;
  const top = hits[0];
  return top && top.score >= 95 ? top : null;
}

const LINK_LABELS: Record<string, string> = {
  "official homepage": "Website",
  bandcamp: "Bandcamp",
  "social network": "Social",
  streaming: "Streaming",
  "free streaming": "Streaming",
  "purchase for download": "Buy",
  discogs: "Discogs",
  allmusic: "AllMusic",
  lastfm: "Last.fm",
  youtube: "YouTube",
  soundcloud: "SoundCloud",
  wikipedia: "Wikipedia",
  bandsintown: "Bandsintown",
  songkick: "Songkick",
  setlistfm: "setlist.fm",
  "other databases": "Database",
};

export interface ArtistInfo {
  mbid: string;
  name: string;
  type?: string;
  country?: string;
  disambiguation?: string;
  beginYear?: number;
  genres: string[];
  links: { label: string; url: string }[];
  wikidataId?: string;
}

export function mapArtist(lookup: unknown): ArtistInfo | null {
  const a = obj(lookup);
  const mbid = str(a.id);
  const name = str(a.name);
  if (!mbid || !name) return null;
  const links: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  let wikidataId: string | undefined;
  for (const rel of arr(a.relations)) {
    const r = obj(rel);
    const type = str(r.type);
    const url = httpsUrl(obj(r.url).resource);
    if (!type || !url) continue;
    if (type === "wikidata") {
      const m = /\/(Q\d+)(?:[/?#]|$)/.exec(url);
      if (m) wikidataId = m[1];
    }
    const label = LINK_LABELS[type];
    if (!label || seen.has(url)) continue;
    seen.add(url);
    links.push({ label, url });
  }
  return {
    mbid,
    name,
    type: str(a.type),
    country: str(a.country),
    disambiguation: str(a.disambiguation),
    beginYear: yearOf(obj(a["life-span"]).begin),
    genres: genreNames(a),
    links: links.slice(0, 12),
    wikidataId,
  };
}

export interface RecordingInfo {
  mbid: string;
  title: string;
  artist: string;
  artistMbid?: string;
  lengthSec?: number;
  year?: number;
  genres: string[];
  releases: { mbid: string; title: string; date?: string; releaseGroupMbid?: string }[];
}

function mapRecordingOne(r: Json): RecordingInfo | null {
  const mbid = str(r.id);
  const title = str(r.title);
  if (!mbid || !title) return null;
  const releases = arr(r.releases)
    .map((x) => {
      const o = obj(x);
      return { mbid: str(o.id), title: str(o.title), date: str(o.date), releaseGroupMbid: str(obj(o["release-group"]).id) };
    })
    .filter((x): x is { mbid: string; title: string; date: string | undefined; releaseGroupMbid: string | undefined } => !!x.mbid && !!x.title);
  const years = releases.map((x) => yearOf(x.date)).filter((y): y is number => y !== undefined);
  const firstRelease = yearOf(r["first-release-date"]);
  const length = num(r.length);
  return {
    mbid,
    title,
    artist: creditName(r["artist-credit"]),
    artistMbid: creditArtistId(r["artist-credit"]),
    lengthSec: length ? Math.round(length / 1000) : undefined,
    year: firstRelease ?? (years.length ? Math.min(...years) : undefined),
    genres: genreNames(r),
    releases: releases.slice(0, 5),
  };
}

export function mapRecording(lookup: unknown): RecordingInfo | null {
  return mapRecordingOne(obj(lookup));
}

/** First recording search hit that clears the confidence bar. */
export function pickRecording(search: unknown): RecordingInfo | null {
  for (const hit of arr(obj(search).recordings)) {
    if ((num(obj(hit).score) ?? 0) < 85) continue;
    const mapped = mapRecordingOne(obj(hit));
    if (mapped) return mapped;
  }
  return null;
}

export interface ReleaseInfo {
  mbid: string;
  title: string;
  artist: string;
  date?: string;
  year?: number;
  country?: string;
  releaseGroupMbid?: string;
  trackCount?: number;
  genres: string[];
  coverUrl: string;
}

function mapReleaseOne(r: Json): ReleaseInfo | null {
  const mbid = str(r.id);
  const title = str(r.title);
  if (!mbid || !title) return null;
  return {
    mbid,
    title,
    artist: creditName(r["artist-credit"]),
    date: str(r.date),
    year: yearOf(r.date),
    country: str(r.country),
    releaseGroupMbid: str(obj(r["release-group"]).id),
    trackCount: num(r["track-count"]),
    genres: genreNames(r),
    coverUrl: `https://coverartarchive.org/release/${mbid}/front-500`,
  };
}

export function mapRelease(lookup: unknown): ReleaseInfo | null {
  return mapReleaseOne(obj(lookup));
}

export function pickRelease(search: unknown): ReleaseInfo | null {
  for (const hit of arr(obj(search).releases)) {
    if ((num(obj(hit).score) ?? 0) < 85) continue;
    const mapped = mapReleaseOne(obj(hit));
    if (mapped) return mapped;
  }
  return null;
}

export interface ReleaseGroupInfo {
  mbid: string;
  title: string;
  artist: string;
  type: string;
  date: string;
  coverUrl: string;
}

const NOT_NEW_MUSIC = new Set(["Live", "Compilation", "Remix", "DJ-mix", "Demo", "Soundtrack", "Spokenword"]);

/** Release groups from a search, kept to the requested artist and a first-release date, newest first. */
export function mapReleaseGroups(search: unknown, artist?: string): ReleaseGroupInfo[] {
  const wanted = artist?.trim().toLowerCase();
  const out: ReleaseGroupInfo[] = [];
  for (const hit of arr(obj(search)["release-groups"])) {
    const g = obj(hit);
    const mbid = str(g.id);
    const title = str(g.title);
    const date = str(g["first-release-date"]);
    if (!mbid || !title || !date) continue;
    const credit = arr(g["artist-credit"]);
    const names = credit.map((c) => (str(obj(c).name) ?? str(obj(obj(c).artist).name) ?? "").toLowerCase());
    if (wanted && !names.includes(wanted) && creditName(credit).toLowerCase() !== wanted) continue;
    const secondary = arr(g["secondary-types"]).map(str);
    if (secondary.some((t) => t !== undefined && NOT_NEW_MUSIC.has(t))) continue;
    out.push({
      mbid,
      title,
      artist: creditName(credit),
      type: str(g["primary-type"]) ?? "Release",
      date,
      coverUrl: `https://coverartarchive.org/release-group/${mbid}/front-250`,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export interface CoverInfo {
  url: string;
  full?: string;
  mbid: string;
  kind: "release" | "release-group";
}

/** The front image of a Cover Art Archive listing. */
export function mapCover(listing: unknown, mbid: string, kind: CoverInfo["kind"]): CoverInfo | null {
  const images = arr(obj(listing).images).map(obj);
  const front = images.find((i) => i.front === true) ?? images[0];
  if (!front) return null;
  const thumbs = obj(front.thumbnails);
  const url = httpsUrl(thumbs["500"]) ?? httpsUrl(thumbs.large) ?? httpsUrl(thumbs["250"]) ?? httpsUrl(thumbs.small) ?? httpsUrl(front.image);
  if (!url) return null;
  return { url, full: httpsUrl(front.image), mbid, kind };
}

export function wikidataTitle(entities: unknown, id: string, site: string): string | undefined {
  const entity = obj(obj(obj(entities).entities)[id]);
  return str(obj(obj(entity.sitelinks)[site]).title);
}

export interface WikiSummary {
  title: string;
  description?: string;
  extract: string;
  image?: string;
  url?: string;
  disambiguation: boolean;
}

export function mapWikiSummary(summary: unknown): WikiSummary | null {
  const s = obj(summary);
  const title = str(s.title);
  const extract = str(s.extract);
  if (!title || !extract) return null;
  return {
    title,
    description: str(s.description),
    extract,
    image: httpsUrl(obj(s.thumbnail).source) ?? httpsUrl(obj(s.originalimage).source),
    url: httpsUrl(obj(obj(s.content_urls).desktop).page),
    disambiguation: s.type === "disambiguation",
  };
}

const MUSICY = /\b(band|musician|singer|songwriter|rapper|duo|group|composer|producer|dj|vocalist|guitarist|pianist|drummer|artist|rock|pop|hip hop|music)/i;
export const looksLikeMusicArtist = (s: WikiSummary) => !s.disambiguation && MUSICY.test(`${s.description ?? ""} ${s.extract.slice(0, 200)}`);

export interface FanartInfo {
  name?: string;
  mbid?: string;
  thumbs: string[];
  backgrounds: string[];
  logos: string[];
  banners: string[];
}

function fanartUrls(list: unknown, max = 6): string[] {
  return arr(list)
    .map((x) => ({ url: httpsUrl(obj(x).url), likes: Number(obj(x).likes) || 0 }))
    .filter((x): x is { url: string; likes: number } => !!x.url)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, max)
    .map((x) => x.url);
}

export function mapFanart(data: unknown): FanartInfo | null {
  const d = obj(data);
  const out: FanartInfo = {
    name: str(d.name),
    mbid: str(d.mbid_id),
    thumbs: fanartUrls(d.artistthumb),
    backgrounds: fanartUrls(d.artistbackground),
    logos: fanartUrls(arr(d.hdmusiclogo).length ? d.hdmusiclogo : d.musiclogo),
    banners: fanartUrls(d.musicbanner),
  };
  return out.thumbs.length + out.backgrounds.length + out.logos.length + out.banners.length > 0 ? out : null;
}

export interface DiscogsArtist {
  id: number;
  name: string;
  profile?: string;
  url?: string;
  images: string[];
  links: { label: string; url: string }[];
}

export function pickDiscogsArtist(search: unknown, name: string): number | null {
  const results = arr(obj(search).results).map(obj);
  const wanted = name.trim().toLowerCase();
  const hit = results.find((r) => str(r.title)?.toLowerCase() === wanted) ?? results[0];
  const id = num(hit?.id);
  return id !== undefined ? id : null;
}

export function mapDiscogsArtist(data: unknown): DiscogsArtist | null {
  const d = obj(data);
  const id = num(d.id);
  const name = str(d.name);
  if (id === undefined || !name) return null;
  const links = arr(d.urls)
    .map(httpsUrl)
    .filter((u): u is string => !!u)
    .slice(0, 6)
    .map((url) => ({ label: new URL(url).hostname.replace(/^www\./, ""), url }));
  return {
    id,
    name,
    // Discogs profiles contain markup like [a=Name]; strip the tags and keep the text.
    profile: str(d.profile)
      ?.replace(/\[[a-z]=([^\]]+)\]/gi, "$1")
      .replace(/\[\/?[a-z]+\]/gi, "")
      .trim(),
    url: httpsUrl(d.uri),
    images: arr(d.images)
      .map((i) => httpsUrl(obj(i).uri150) ?? httpsUrl(obj(i).uri))
      .filter((u): u is string => !!u)
      .slice(0, 4),
    links,
  };
}

export interface DiscogsRelease {
  id: number;
  title: string;
  year?: number;
  genres: string[];
  styles: string[];
  cover?: string;
  url?: string;
}

export function mapDiscogsReleases(search: unknown): DiscogsRelease[] {
  return arr(obj(search).results)
    .map(obj)
    .map((r): DiscogsRelease | null => {
      const id = num(r.id);
      const title = str(r.title);
      if (id === undefined || !title) return null;
      const year = Number(r.year);
      const uri = str(r.uri);
      return {
        id,
        title,
        year: Number.isInteger(year) && year > 0 ? year : undefined,
        genres: arr(r.genre).map(str).filter((g): g is string => !!g),
        styles: arr(r.style).map(str).filter((g): g is string => !!g),
        cover: httpsUrl(r.cover_image),
        url: uri ? httpsUrl(`https://www.discogs.com${uri}`) : undefined,
      };
    })
    .filter((r): r is DiscogsRelease => r !== null)
    .slice(0, 5);
}

export interface ConcertInfo {
  id: string;
  artist: string;
  datetime: string;
  title?: string;
  venue: string;
  city: string;
  region?: string;
  country: string;
  latitude?: number;
  longitude?: number;
  url?: string;
  ticketUrl?: string;
  lineup: string[];
}

function coordinate(v: unknown): number | undefined {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function mapEvents(data: unknown, artist: string): ConcertInfo[] {
  return arr(data)
    .map(obj)
    .map((e): ConcertInfo | null => {
      const id = str(e.id) ?? (num(e.id) !== undefined ? String(e.id) : undefined);
      const datetime = str(e.datetime) ?? str(e.starts_at);
      const venue = obj(e.venue);
      if (!id || !datetime) return null;
      const offer = arr(e.offers).map(obj).find((o) => str(o.url));
      return {
        id,
        artist,
        datetime,
        title: str(e.title),
        venue: str(venue.name) ?? "Venue",
        city: str(venue.city) ?? "",
        region: str(venue.region),
        country: str(venue.country) ?? "",
        latitude: coordinate(venue.latitude),
        longitude: coordinate(venue.longitude),
        url: httpsUrl(e.url),
        ticketUrl: httpsUrl(offer?.url),
        lineup: arr(e.lineup).map(str).filter((n): n is string => !!n).slice(0, 8),
      };
    })
    .filter((e): e is ConcertInfo => e !== null);
}

/** Bandsintown wants a few characters in artist names escaped twice inside the path. */
export function bandsintownName(name: string): string {
  return encodeURIComponent(name)
    .replace(/%2F/gi, "%252F")
    .replace(/%3F/gi, "%253F")
    .replace(/\*/g, "%252A")
    .replace(/%22/g, "%27C");
}
