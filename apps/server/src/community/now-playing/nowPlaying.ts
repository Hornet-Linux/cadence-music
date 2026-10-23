// What each person is playing right now, kept in memory only (never stored), and
// the people watching it through overlay links.

export type PlayState = "playing" | "paused" | "stopped";

export interface NowPlayingTrack {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  /** A public https image, or absent. */
  artwork?: string;
}

export interface Heartbeat {
  state: PlayState;
  track?: NowPlayingTrack;
  positionSec: number;
  durationSec: number;
  /** Server clock (ms) when the heartbeat arrived. */
  receivedAt: number;
}

/** What overlays receive. */
export interface Snapshot {
  active: boolean;
  playing: boolean;
  title: string;
  artists: string;
  album: string;
  artwork: string;
  durationSec: number;
  /** Where the song is now (already advanced by the time since the heartbeat). */
  positionSec: number;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  active: false,
  playing: false,
  title: "",
  artists: "",
  album: "",
  artwork: "",
  durationSec: 0,
  positionSec: 0,
};

/** Heartbeats come every ~15 s while playing; a missing one for this long means the player is gone. */
export const PLAYING_STALE_MS = 60_000;
/** A paused song stays on the overlay this long. */
export const PAUSED_VISIBLE_MS = 5 * 60_000;

export function snapshotOf(beat: Heartbeat | undefined, now: number): Snapshot {
  if (!beat || !beat.track || beat.state === "stopped") return EMPTY_SNAPSHOT;
  const age = now - beat.receivedAt;
  const playing = beat.state === "playing";
  if (playing ? age > PLAYING_STALE_MS : age > PAUSED_VISIBLE_MS) return EMPTY_SNAPSHOT;
  const advanced = playing ? beat.positionSec + age / 1000 : beat.positionSec;
  return {
    active: true,
    playing,
    title: beat.track.title,
    artists: beat.track.artists.join(", "),
    album: beat.track.album ?? "",
    artwork: beat.track.artwork ?? "",
    durationSec: beat.durationSec,
    positionSec: beat.durationSec > 0 ? Math.min(advanced, beat.durationSec) : advanced,
  };
}

const TEXT = 300;
const text = (v: unknown, max = TEXT): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : undefined;
const seconds = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 100_000 ? Math.round(v * 10) / 10 : 0;

/** Only an https address on the public internet: an overlay in OBS (or a browser) must be able to load it. */
export function publicHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 500) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return undefined;
  if (host.startsWith("[") || !host.includes(".")) return undefined;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return undefined;
    }
  }
  return url.toString();
}

/** Check an untrusted heartbeat from a client; null if it is unusable. */
export function parseHeartbeat(input: unknown, now: number): Heartbeat | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (raw.state !== "playing" && raw.state !== "paused" && raw.state !== "stopped") return null;
  if (raw.state === "stopped") return { state: "stopped", positionSec: 0, durationSec: 0, receivedAt: now };
  const t = (raw.track ?? null) as Record<string, unknown> | null;
  const id = text(t?.id, 500);
  const title = text(t?.title);
  if (!t || !id || !title) return null;
  const artists = Array.isArray(t.artists)
    ? t.artists
        .slice(0, 10)
        .map((a) => text(typeof a === "string" ? a : (a as { name?: unknown } | null)?.name, 150))
        .filter((a): a is string => !!a)
    : [];
  return {
    state: raw.state,
    track: { id, title, artists, album: text(t.album), artwork: publicHttpsUrl(t.artwork) },
    positionSec: seconds(raw.positionSec),
    durationSec: seconds(raw.durationSec),
    receivedAt: now,
  };
}

export interface Subscriber {
  tokenId: number;
  send: (snapshot: Snapshot) => void;
  close: () => void;
}

/** Latest heartbeat per person, and the open overlay connections for each. */
export class NowPlayingHub {
  private readonly beats = new Map<number, Heartbeat>();
  private readonly subscribers = new Map<number, Set<Subscriber>>();

  update(userId: number, beat: Heartbeat): void {
    this.beats.set(userId, beat);
    this.publish(userId, beat.receivedAt);
  }

  snapshot(userId: number, now: number): Snapshot {
    return snapshotOf(this.beats.get(userId), now);
  }

  subscribe(userId: number, sub: Subscriber): () => void {
    const set = this.subscribers.get(userId) ?? new Set();
    set.add(sub);
    this.subscribers.set(userId, set);
    return () => {
      set.delete(sub);
      if (set.size === 0) this.subscribers.delete(userId);
    };
  }

  countFor(userId: number, tokenId?: number): number {
    const set = this.subscribers.get(userId);
    if (!set) return 0;
    return tokenId === undefined ? set.size : [...set].filter((s) => s.tokenId === tokenId).length;
  }

  total(): number {
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }

  /** Disconnect everything using a revoked link. */
  dropToken(userId: number, tokenId: number): void {
    for (const sub of [...(this.subscribers.get(userId) ?? [])]) if (sub.tokenId === tokenId) sub.close();
  }

  /** Push the current snapshot to a person's overlays. */
  publish(userId: number, now: number): void {
    const snap = this.snapshot(userId, now);
    for (const sub of [...(this.subscribers.get(userId) ?? [])]) {
      try {
        sub.send(snap);
      } catch {
        sub.close();
      }
    }
  }

  /** Periodic upkeep: tell overlays when a song has gone stale, and forget long-dead heartbeats. */
  tick(now: number): void {
    for (const [userId, beat] of this.beats) {
      const age = now - beat.receivedAt;
      if (age > 60 * 60_000 && !this.subscribers.has(userId)) {
        this.beats.delete(userId);
        continue;
      }
      // Re-send so overlays notice staleness and keep their progress honest.
      if (this.subscribers.has(userId)) this.publish(userId, now);
    }
  }
}