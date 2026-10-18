export interface Artist {
  id: string;
  name: string;
}

export interface Track {
  id: string;
  title: string;
  artists: Artist[];
  album?: string;
  /** Cover art URL. */
  artwork?: string;
  /** Duration in seconds, if known. */
  durationSec?: number;
  /** Which source/plugin this track came from, e.g. "local", "spotify". */
  source?: string;
}

export interface Playlist {
  id: string;
  name: string;
  artwork?: string;
  trackCount: number;
}

export function primaryArtist(track: Track): string {
  return track.artists.map((a) => a.name).join(", ") || "Unknown artist";
}

export function formatDuration(totalSeconds: number | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return "--:--";
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
