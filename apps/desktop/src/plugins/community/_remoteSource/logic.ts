import type { Track } from "@/shared/types";

/** A track as the server's remote-source routes return it (paths and credentials stay on the server). */
export interface RemoteTrackDto {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  durationSec: number | null;
  location: string | null;
}

export interface IndexingDto {
  running: boolean;
  status: "running" | "done" | "failed" | "interrupted" | "never";
  found: number;
  indexed: number;
  removed: number;
  failed: number;
  finishedAt: number | null;
  error: string | null;
}

export const NEVER_INDEXED: IndexingDto = { running: false, status: "never", found: 0, indexed: 0, removed: 0, failed: 0, finishedAt: null, error: null };

/** The server's base answer for any source: are we connected, how much is cached, what is the indexer doing. */
export interface RemoteStatus {
  connected: boolean;
  trackCount: number;
  indexing: IndexingDto;
}

export function toTrack(dto: RemoteTrackDto, prefix: string, source: string): Track {
  const artist = dto.artist ?? dto.albumArtist;
  return {
    id: `${prefix}${dto.id}`,
    title: dto.title,
    artists: [{ id: artist ?? "unknown", name: artist ?? "Unknown artist" }],
    album: dto.album ?? undefined,
    durationSec: dto.durationSec ?? undefined,
    source,
  };
}

/** The server's id for a Cadence track of this source, or null for tracks of other sources. */
export function remoteId(track: { id: string }, prefix: string): string | null {
  return track.id.startsWith(prefix) && track.id.length > prefix.length ? track.id.slice(prefix.length) : null;
}

/** Strips the "Request failed (400): " the server store adds, leaving the sentence the server wrote. */
export function plainError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Request failed \(\d+\):\s*/, "").replace(/^Request failed \(\d+\)$/, "The server couldn't do that");
}

export function timeAgo(ts: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const ERROR_TEXT: Record<string, string> = {
  auth_failed: "The service refused the saved sign-in. Connect again.",
  needs_reconnect: "The sign-in expired. Connect again.",
  upstream: "The service returned an error. It will try again later.",
  bad_response: "The service answered in a way Cadence doesn't understand.",
  not_found: "The folder or share wasn't found.",
  timeout: "The service took too long to answer.",
  unreachable: "The service couldn't be reached.",
  blocked: "The address isn't allowed on this server.",
  insecure: "The address must use https://.",
  redirect: "The service redirected somewhere that can't be used.",
  too_large: "The service sent more data than Cadence accepts.",
  invalid_url: "The address isn't valid.",
  failed: "Indexing failed. It will try again later.",
};

export interface IndexSummary {
  /** Short line for the settings panel and the page header. */
  text: string;
  busy: boolean;
  /** Something the person can act on (shown as a notice). */
  problem: string | null;
}

/** Turns the server's indexer state into words. */
export function summarizeIndexing(trackCount: number, i: IndexingDto, now = Date.now()): IndexSummary {
  const tracks = `${trackCount} ${trackCount === 1 ? "track" : "tracks"}`;
  if (i.running) {
    return { text: i.found > 0 ? `Indexing… found ${i.found} files, ${tracks} ready` : "Looking through your files…", busy: true, problem: null };
  }
  const unread = i.status === "done" && i.failed > 0 ? `${i.failed} ${i.failed === 1 ? "file" : "files"} couldn't be read, so ${i.failed === 1 ? "it isn't" : "they aren't"} in your library. Refresh to try again.` : null;
  const problem = i.status === "failed" ? (ERROR_TEXT[i.error ?? "failed"] ?? ERROR_TEXT.failed!) : unread;
  if (i.status === "never") return { text: "Not indexed yet", busy: false, problem: null };
  if (i.status === "interrupted") return { text: `${tracks}. Indexing was interrupted and will carry on.`, busy: false, problem: null };
  const when = i.finishedAt ? `, updated ${timeAgo(i.finishedAt, now)}` : "";
  return { text: `${tracks}${when}`, busy: false, problem };
}

/** A folder choice: `key` is what the server uses (a path, a key prefix or a drive folder id). */
export interface FolderChoice {
  key: string;
  name: string;
}

/** Adds the folder if it isn't chosen, removes it if it is. A parent and its child may both be chosen; the server de-duplicates. */
export function toggleChoice(list: FolderChoice[], choice: FolderChoice): FolderChoice[] {
  return list.some((c) => c.key === choice.key) ? list.filter((c) => c.key !== choice.key) : [...list, choice];
}

/**
 * A folder path as clickable crumbs. WebDAV paths look like "/Music/Rock" (root "/"); S3 key prefixes like
 * "Music/Rock/" (root "").
 */
export function crumbs(path: string, rootName: string, style: "path" | "prefix"): FolderChoice[] {
  const parts = path.split("/").filter(Boolean);
  const out: FolderChoice[] = [{ key: style === "path" ? "/" : "", name: rootName }];
  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    out.push({ key: style === "path" ? acc : acc.slice(1) + "/", name: part });
  }
  return out;
}

/** Reuses a signed stream link until shortly before it expires. */
export class StreamLinkCache {
  private readonly links = new Map<string, { url: string; expiresAt: number }>();
  constructor(
    private readonly marginSec = 60,
    private readonly now: () => number = () => Date.now(),
  ) {}
  get(id: string): string | null {
    const hit = this.links.get(id);
    return hit && hit.expiresAt - this.now() / 1000 > this.marginSec ? hit.url : null;
  }
  set(id: string, url: string, expiresAt: number): void {
    if (this.links.size > 500) this.links.clear();
    this.links.set(id, { url, expiresAt });
  }
  clear(): void {
    this.links.clear();
  }
}
