import { create } from "zustand";
import type { Play, TopTrack } from "@uma/shared";
import { usePlayer } from "@/player/playerStore";
import type { Track } from "@/shared/types";

// Listening history kept on this device. Plugins (the server plugin today)
// can sync it: they read `pending`, upload it, and merge remote plays back in.

const PLAYS_KEY = "history:plays";
const PENDING_KEY = "history:pending";
const MAX_PLAYS = 2000;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full; history is best effort.
  }
}

const playKey = (p: Play) => `${p.track.id}@${p.playedAt}`;

/** Strip a track down to what history needs to show it again. */
function snapshot(track: Track): Track {
  return {
    id: track.id,
    title: track.title,
    artists: track.artists,
    album: track.album,
    artwork: track.artwork,
    durationSec: track.durationSec,
    source: track.source,
  };
}

interface HistoryState {
  /** Newest first. */
  plays: Play[];
  /** Plays not yet uploaded by a sync plugin. */
  pending: Play[];
  /** Server-side "most played" (all devices), when a sync plugin provides it. */
  remoteTop: TopTrack[] | null;
  record: (track: Track) => void;
  /** Merge plays from elsewhere (e.g. other devices via the server). */
  merge: (plays: Play[]) => void;
  /** Drop the first `count` pending plays after a successful upload. */
  markUploaded: (count: number) => void;
  setRemoteTop: (top: TopTrack[] | null) => void;
  clear: () => void;
}

export const useHistory = create<HistoryState>((set, get) => ({
  plays: read<Play[]>(PLAYS_KEY, []),
  pending: read<Play[]>(PENDING_KEY, []),
  remoteTop: null,

  record(track) {
    const play: Play = { track: snapshot(track), playedAt: Date.now() };
    const plays = [play, ...get().plays].slice(0, MAX_PLAYS);
    const pending = [...get().pending, play].slice(-MAX_PLAYS);
    set({ plays, pending });
    write(PLAYS_KEY, plays);
    write(PENDING_KEY, pending);
  },

  merge(incoming) {
    const seen = new Set(get().plays.map(playKey));
    const fresh = incoming.filter((p) => !seen.has(playKey(p)));
    if (fresh.length === 0) return;
    const plays = [...get().plays, ...fresh].sort((a, b) => b.playedAt - a.playedAt).slice(0, MAX_PLAYS);
    set({ plays });
    write(PLAYS_KEY, plays);
  },

  markUploaded(count) {
    const pending = get().pending.slice(count);
    set({ pending });
    write(PENDING_KEY, pending);
  },

  setRemoteTop(remoteTop) {
    set({ remoteTop });
  },

  clear() {
    set({ plays: [], pending: [], remoteTop: null });
    write(PLAYS_KEY, []);
    write(PENDING_KEY, []);
  },
}));

/** Most recent distinct tracks. */
export function recentTracks(plays: Play[], limit = 12): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const p of plays) {
    if (seen.has(p.track.id)) continue;
    seen.add(p.track.id);
    out.push(p.track);
    if (out.length >= limit) break;
  }
  return out;
}

/** Tracks ranked by play count (ties: most recent first). */
export function topTracks(plays: Play[], limit = 12): { track: Track; plays: number }[] {
  const counts = new Map<string, { track: Track; plays: number; last: number }>();
  for (const p of plays) {
    const entry = counts.get(p.track.id);
    if (entry) entry.plays++;
    else counts.set(p.track.id, { track: p.track, plays: 1, last: p.playedAt });
  }
  return [...counts.values()]
    .sort((a, b) => b.plays - a.plays || b.last - a.last)
    .slice(0, limit)
    .map(({ track, plays: n }) => ({ track, plays: n }));
}

let tracking = false;

/** Count a play after 30 seconds (or half of a shorter track). */
export function startHistoryTracking(): void {
  if (tracking) return;
  tracking = true;
  let lastId: string | null = null;
  let lastPosition = 0;
  let recorded = false;
  usePlayer.subscribe((s) => {
    const id = s.current?.id ?? null;
    // A new track, or the same one restarted (repeat / previous), counts again.
    if (id !== lastId || s.position < lastPosition - 5) {
      lastId = id;
      recorded = false;
    }
    lastPosition = s.position;
    if (recorded || !s.current || !s.isPlaying) return;
    const threshold = s.duration > 0 ? Math.min(30, s.duration / 2) : 30;
    if (s.position >= threshold) {
      recorded = true;
      useHistory.getState().record(s.current);
    }
  });
}
