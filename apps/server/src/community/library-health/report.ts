/** Pure logic for the library health report (duplicates, missing tags and artwork, unreadable files). */

export interface HealthTrack {
  id: string;
  relPath: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  size: number;
  durationSec: number | null;
  genre: string | null;
  year: number | null;
  /** null until the file has been indexed. */
  hasArtwork: boolean | null;
  hasTitleTag: boolean | null;
  indexed: boolean;
  error: string | null;
  decodeError: string | null;
  bitrate: number | null;
  codec: string | null;
  lossless: boolean | null;
}

/** Lower-case, accent-free text with punctuation, "feat." credits and a leading "the" removed. */
export function normalizeText(input: string | null | undefined): string {
  return (input ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s*[([]?\s*\b(?:feat|ft|featuring)\b\.?[^)\]]*[)\]]?/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");
}

export interface DuplicateMember {
  id: string;
  relPath: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  size: number;
  bitrate: number | null;
  codec: string | null;
  lossless: boolean | null;
}

export interface DuplicateGroup {
  /** exact: same size and length, almost certainly the same audio. likely: same title and artist, similar length. */
  confidence: "exact" | "likely";
  reasons: string[];
  sameAlbum: boolean;
  /** The copy most worth keeping (lossless, then bitrate, then size). */
  suggestedKeepId: string;
  tracks: DuplicateMember[];
}

class DisjointSet {
  private readonly parent = new Map<string, string>();
  find(a: string): string {
    let root = this.parent.get(a) ?? a;
    if (root !== a) {
      root = this.find(root);
      this.parent.set(a, root);
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Sorted-by-length chains: neighbours within `tolerance` seconds are linked. */
function chain(items: HealthTrack[], tolerance: number, link: (a: HealthTrack, b: HealthTrack) => void): void {
  const sorted = [...items].sort((a, b) => (a.durationSec ?? Infinity) - (b.durationSec ?? Infinity));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (a.durationSec !== null && b.durationSec !== null && Math.abs(a.durationSec - b.durationSec) <= tolerance) link(a, b);
    // Unknown length on either side: only trust an identical file size.
    else if ((a.durationSec === null || b.durationSec === null) && a.size === b.size && a.size > 0) link(a, b);
  }
}

const sameLength = (a: HealthTrack, b: HealthTrack) =>
  a.durationSec === null || b.durationSec === null || Math.abs(a.durationSec - b.durationSec) <= 0.1;

export function findDuplicateGroups(tracks: HealthTrack[]): DuplicateGroup[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const sets = new DisjointSet();
  const reasonsBy = new Map<string, Set<string>>();
  const note = (a: HealthTrack, b: HealthTrack, reason: string) => {
    sets.union(a.id, b.id);
    for (const id of [a.id, b.id]) {
      const set = reasonsBy.get(id) ?? new Set();
      set.add(reason);
      reasonsBy.set(id, set);
    }
  };

  // Rule A: same title and artist (and album when there is no artist), lengths within 2 seconds.
  const titleBuckets = new Map<string, HealthTrack[]>();
  for (const t of tracks) {
    const title = normalizeText(t.title);
    if (!title) continue;
    const artist = normalizeText(t.artist ?? t.albumArtist);
    const key = artist ? `${title}|${artist}` : `${title}||${normalizeText(t.album)}`;
    const bucket = titleBuckets.get(key);
    if (bucket) bucket.push(t);
    else titleBuckets.set(key, [t]);
  }
  for (const bucket of titleBuckets.values()) {
    if (bucket.length > 1) chain(bucket, 2, (a, b) => note(a, b, "same title and artist"));
  }

  // Rule B (fingerprint-lite): identical file size and length, whatever the tags say.
  const sizeBuckets = new Map<number, HealthTrack[]>();
  for (const t of tracks) {
    if (t.size < 50_000) continue;
    const bucket = sizeBuckets.get(t.size);
    if (bucket) bucket.push(t);
    else sizeBuckets.set(t.size, [t]);
  }
  for (const bucket of sizeBuckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (sameLength(bucket[i]!, bucket[j]!)) note(bucket[i]!, bucket[j]!, "same size and length");
      }
    }
  }

  const groups = new Map<string, HealthTrack[]>();
  for (const id of reasonsBy.keys()) {
    const root = sets.find(id);
    const list = groups.get(root) ?? [];
    list.push(byId.get(id)!);
    groups.set(root, list);
  }

  const out: DuplicateGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const reasons = new Set<string>();
    for (const m of members) for (const r of reasonsBy.get(m.id) ?? []) reasons.add(r);
    const first = members[0]!;
    const exact = members.every((m) => m.size === first.size && sameLength(m, first));
    const albums = new Set(members.map((m) => normalizeText(m.album)));
    const ranked = [...members].sort(
      (a, b) =>
        Number(b.lossless === true) - Number(a.lossless === true) ||
        (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
        b.size - a.size ||
        a.relPath.localeCompare(b.relPath),
    );
    out.push({
      confidence: exact ? "exact" : "likely",
      reasons: [...reasons].sort(),
      sameAlbum: albums.size === 1,
      suggestedKeepId: ranked[0]!.id,
      tracks: members
        .sort((a, b) => a.relPath.localeCompare(b.relPath))
        .map((m) => ({
          id: m.id,
          relPath: m.relPath,
          title: m.title,
          artist: m.artist,
          album: m.album,
          durationSec: m.durationSec,
          size: m.size,
          bitrate: m.bitrate,
          codec: m.codec,
          lossless: m.lossless,
        })),
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.confidence === "exact") - Number(a.confidence === "exact") ||
      b.tracks.length - a.tracks.length ||
      a.tracks[0]!.relPath.localeCompare(b.tracks[0]!.relPath),
  );
}

export type MissingField = "title" | "artist" | "album" | "albumArtist" | "trackNo" | "year" | "genre";

export interface ProblemFile {
  id: string;
  relPath: string;
  title: string;
  kind: "unreadable" | "corrupt";
  problem: string;
}

export interface MissingArtworkAlbum {
  album: string | null;
  artist: string | null;
  folder: string;
  tracks: number;
  sampleTrackId: string;
}

export interface MissingTagsItem {
  id: string;
  relPath: string;
  title: string;
  artist: string | null;
  album: string | null;
  missing: MissingField[];
}

export interface HealthReport {
  generatedAt: number;
  summary: {
    tracks: number;
    indexed: number;
    duplicateGroups: number;
    duplicateTracks: number;
    exactDuplicateGroups: number;
    missingArtworkTracks: number;
    missingArtworkAlbums: number;
    tracksMissingTags: number;
    missingTagCounts: Record<MissingField, number>;
    unreadable: number;
    corrupt: number;
  };
  duplicates: DuplicateGroup[];
  missingArtwork: MissingArtworkAlbum[];
  missingTags: MissingTagsItem[];
  problems: ProblemFile[];
}

const MISSING_FIELDS: MissingField[] = ["title", "artist", "album", "albumArtist", "trackNo", "year", "genre"];

function missingFor(t: HealthTrack): MissingField[] {
  const out: MissingField[] = [];
  if (t.hasTitleTag === false) out.push("title");
  if (!t.artist) out.push("artist");
  if (!t.album) out.push("album");
  if (!t.albumArtist) out.push("albumArtist");
  if (t.trackNo === null) out.push("trackNo");
  if (t.indexed && t.year === null) out.push("year");
  if (t.indexed && !t.genre) out.push("genre");
  return out;
}

const folderOf = (relPath: string) => (relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "");

export function classifyProblem(t: HealthTrack): ProblemFile | null {
  const problem = t.error ?? t.decodeError;
  if (!problem) return null;
  const corrupt = t.decodeError !== null || problem.startsWith("no playable duration");
  return { id: t.id, relPath: t.relPath, title: t.title, kind: corrupt ? "corrupt" : "unreadable", problem };
}

export function buildReport(tracks: HealthTrack[], limit = 200, now = Date.now()): HealthReport {
  const duplicates = findDuplicateGroups(tracks);

  const problems: ProblemFile[] = [];
  for (const t of tracks) {
    const p = classifyProblem(t);
    if (p) problems.push(p);
  }

  const artwork = new Map<string, MissingArtworkAlbum>();
  let missingArtworkTracks = 0;
  for (const t of tracks) {
    if (t.hasArtwork !== false || t.error) continue;
    missingArtworkTracks++;
    const folder = folderOf(t.relPath);
    const key = `${folder}|${normalizeText(t.album)}`;
    const entry = artwork.get(key);
    if (entry) entry.tracks++;
    else artwork.set(key, { album: t.album, artist: t.albumArtist ?? t.artist, folder, tracks: 1, sampleTrackId: t.id });
  }

  const counts = Object.fromEntries(MISSING_FIELDS.map((f) => [f, 0])) as Record<MissingField, number>;
  const missingTags: MissingTagsItem[] = [];
  let tracksMissingTags = 0;
  for (const t of tracks) {
    if (t.error) continue;
    const missing = missingFor(t);
    for (const f of missing) counts[f]++;
    // The essentials decide whether a track is listed; the rest only add to the counts.
    const essential = missing.filter((f) => f === "title" || f === "artist" || f === "album");
    if (essential.length > 0) {
      tracksMissingTags++;
      missingTags.push({ id: t.id, relPath: t.relPath, title: t.title, artist: t.artist, album: t.album, missing });
    }
  }
  missingTags.sort((a, b) => b.missing.length - a.missing.length || a.relPath.localeCompare(b.relPath));

  const artworkAlbums = [...artwork.values()].sort((a, b) => b.tracks - a.tracks || a.folder.localeCompare(b.folder));

  return {
    generatedAt: now,
    summary: {
      tracks: tracks.length,
      indexed: tracks.filter((t) => t.indexed).length,
      duplicateGroups: duplicates.length,
      duplicateTracks: duplicates.reduce((n, g) => n + g.tracks.length, 0),
      exactDuplicateGroups: duplicates.filter((g) => g.confidence === "exact").length,
      missingArtworkTracks,
      missingArtworkAlbums: artworkAlbums.length,
      tracksMissingTags,
      missingTagCounts: counts,
      unreadable: problems.filter((p) => p.kind === "unreadable").length,
      corrupt: problems.filter((p) => p.kind === "corrupt").length,
    },
    duplicates: duplicates.slice(0, limit),
    missingArtwork: artworkAlbums.slice(0, limit),
    missingTags: missingTags.slice(0, limit),
    problems: problems.slice(0, limit),
  };
}