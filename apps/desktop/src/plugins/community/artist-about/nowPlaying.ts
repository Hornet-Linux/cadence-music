import { useSyncExternalStore } from "react";
import type { Track } from "@/shared/types";

// The track that is playing, fed by the plugin through ctx.onNowPlaying.
let current: Track | null = null;
const listeners = new Set<() => void>();

export function setCurrentTrack(track: Track | null) {
  if (current?.id === track?.id) return;
  current = track;
  for (const l of listeners) l();
}

export function useCurrentTrack(): Track | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
}
