import { useMemo } from "react";
import { useCollection } from "@/features/collection/collectionStore";
import { useHistory } from "@/features/history/historyStore";
import { useLocalFiles } from "@/plugins/builtins/localFilesStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import type { Track } from "@/shared/types";

/** Merge track lists, keeping the first copy of each id. */
export function dedupeTracks(...lists: Track[][]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const list of lists) {
    for (const t of list) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/**
 * The tracks the person can browse without any external service: their server library, local
 * files, liked songs and recently played. Streaming-service libraries (Spotify, Apple Music) are
 * listed by their own plugins and are not included here.
 */
export function useLibraryTracks(options: { includeHistory?: boolean } = {}): Track[] {
  const server = useServer((s) => s.tracks);
  const local = useLocalFiles((s) => s.tracks);
  const likes = useCollection((s) => s.likes);
  const plays = useHistory((s) => s.plays);
  const includeHistory = options.includeHistory ?? true;
  return useMemo(
    () => dedupeTracks(server, local, likes.map((l) => l.track), includeHistory ? plays.map((p) => p.track) : []),
    [server, local, likes, plays, includeHistory],
  );
}