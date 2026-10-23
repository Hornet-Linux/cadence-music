export type MissingField = "title" | "artist" | "album" | "albumArtist" | "trackNo" | "year" | "genre";

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
  confidence: "exact" | "likely";
  reasons: string[];
  sameAlbum: boolean;
  suggestedKeepId: string;
  tracks: DuplicateMember[];
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
  missingArtwork: { album: string | null; artist: string | null; folder: string; tracks: number; sampleTrackId: string }[];
  missingTags: {
    id: string;
    relPath: string;
    title: string;
    artist: string | null;
    album: string | null;
    missing: MissingField[];
  }[];
  problems: { id: string; relPath: string; title: string; kind: "unreadable" | "corrupt"; problem: string }[];
}

export interface BatchStatus {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  current: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string | null;
}

export interface HealthStatus {
  ffmpeg: { available: boolean; version: string | null };
  indexing: BatchStatus & { pending: number };
  deepScan: BatchStatus & { pending: number };
}

export const FIELD_LABELS: Record<MissingField, string> = {
  title: "title",
  artist: "artist",
  album: "album",
  albumArtist: "album artist",
  trackNo: "track no.",
  year: "year",
  genre: "genre",
};
