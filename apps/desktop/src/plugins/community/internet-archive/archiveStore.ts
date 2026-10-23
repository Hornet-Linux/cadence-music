import type { Track } from "@/shared/types";
import { query, serverApi, serverUrl } from "../_sourcekit/api";

export const ARCHIVE_PREFIX = "archive:";

export interface ArchiveItem {
  id: string;
  title: string;
  creator?: string;
  date?: string;
  year?: number;
  downloads: number;
  kind: "audio" | "etree" | "collection";
  licence?: string;
  cover: string;
}

export interface ArchiveTrackInfo {
  title: string;
  track: number | null;
  durationSec: number;
  size: number;
  format: string;
  /** Signed relative path; carries the file name in `f`. */
  path: string;
}

export interface ArchiveDetail {
  id: string;
  title: string;
  creator?: string;
  date?: string;
  description?: string;
  venue?: string;
  coverage?: string;
  taper?: string;
  source?: string;
  collections: string[];
  cover: string;
  format: "mp3" | "ogg" | "flac";
  formats: ("mp3" | "ogg" | "flac")[];
  tracks: ArchiveTrackInfo[];
  attribution: { text: string; detailsUrl: string; licence?: { name: string; url: string }; rights?: string };
}

export interface SearchPage {
  items: ArchiveItem[];
  total: number;
  page: number;
  hasMore: boolean;
}

/** The file name a listed track points at (it travels in the signed path's `f` parameter). */
export function fileOf(path: string): string | null {
  const q = path.split("?")[1];
  return q ? new URLSearchParams(q).get("f") : null;
}

export function archiveTrackId(identifier: string, file: string): string {
  return `${ARCHIVE_PREFIX}${identifier}/${file}`;
}

/** Splits `archive:<identifier>/<file...>`. Identifiers never contain a slash; file names may. */
export function parseArchiveTrackId(id: string): { identifier: string; file: string } | null {
  if (!id.startsWith(ARCHIVE_PREFIX)) return null;
  const rest = id.slice(ARCHIVE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { identifier: rest.slice(0, slash), file: rest.slice(slash + 1) };
}

export function detailToTracks(d: ArchiveDetail): Track[] {
  const licence = d.attribution.licence?.name;
  const out: Track[] = [];
  for (const t of d.tracks) {
    const file = fileOf(t.path);
    if (!file) continue;
    out.push({
      id: archiveTrackId(d.id, file),
      title: t.title,
      artists: [{ id: d.creator ?? "archive", name: d.creator ?? "Internet Archive" }],
      album: licence ? `${d.title} · ${licence}` : d.title,
      artwork: serverUrl(d.cover),
      durationSec: t.durationSec || undefined,
      source: "archive",
    });
  }
  return out;
}

export async function searchArchive(q: { q?: string; kind?: "audio" | "etree"; collection?: string; year?: string; sort?: string; page?: number }): Promise<SearchPage> {
  return serverApi(`api/archive/search${query({ q: q.q, kind: q.kind, collection: q.collection, year: q.year, sort: q.sort, page: q.page })}`);
}

export async function fetchBands(q: string, page = 1): Promise<{ items: ArchiveItem[]; total: number }> {
  return serverApi(`api/archive/etree/bands${query({ q, page })}`);
}

export async function fetchArchiveItem(id: string, format?: "mp3" | "ogg" | "flac"): Promise<ArchiveDetail> {
  return serverApi(`api/archive/items/${encodeURIComponent(id)}${query({ format: format === "mp3" ? undefined : format })}`);
}

/** A fresh signed address for one file. */
export async function streamAddress(identifier: string, file: string): Promise<string> {
  const res = await serverApi<{ path: string }>(`api/archive/stream-url${query({ id: identifier, f: file })}`);
  return serverUrl(res.path)!;
}

export function yearOf(item: { year?: number; date?: string }): string {
  return item.year ? String(item.year) : (item.date?.slice(0, 4) ?? "");
}