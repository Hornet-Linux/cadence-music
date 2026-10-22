import { usePlayer } from "@/player/playerStore";
import { jellyfinItemId, useJellyfin } from "./jellyfinStore";

/** How often a playing track reports its position. */
export const PROGRESS_EVERY_MS = 30_000;

type Event = "start" | "progress" | "stop";
type Send = (event: Event, itemId: string, positionSec: number) => void;

interface Snapshot {
  current: { id: string } | null;
  isPlaying: boolean;
  position: number;
  duration: number;
}

/**
 * Turns player state changes into Jellyfin playback reports: "start" when a
 * Jellyfin track begins playing, "progress" every 30 s while it plays, and
 * "stop" when it ends, is skipped or replaced. Pausing is not a stop. Other
 * sources are never reported. Feed it every (state, previous state) pair.
 */
export function createPlaybackReporter(send: Send, now: () => number = Date.now) {
  let reporting: string | null = null;
  let lastReportAt = 0;

  return function onPlayerChange(state: Snapshot, prev: Snapshot) {
    const itemId = state.current ? jellyfinItemId(state.current) : null;

    // The track changed (or playback ended): close out the one we were reporting.
    const ended = !state.isPlaying && prev.isPlaying && state.duration > 0 && state.position >= state.duration - 1;
    if (reporting && (reporting !== itemId || ended)) {
      send("stop", reporting, state.current?.id === prev.current?.id ? state.position : prev.position);
      reporting = null;
    }

    if (!itemId || !state.isPlaying) return;
    if (reporting !== itemId) {
      reporting = itemId;
      lastReportAt = now();
      send("start", itemId, state.position);
    } else if (now() - lastReportAt >= PROGRESS_EVERY_MS) {
      lastReportAt = now();
      send("progress", itemId, state.position);
    }
  };
}

let started = false;

/** Report Jellyfin plays for the lifetime of the app. Safe to call more than once. */
export function startPlaybackReporting(): void {
  if (started) return;
  started = true;
  const onChange = createPlaybackReporter((event, itemId, positionSec) => {
    // Signed out of Jellyfin: nothing to tell it.
    if (useJellyfin.getState().status?.connected) void useJellyfin.getState().report(event, itemId, positionSec);
  });
  usePlayer.subscribe(onChange);
}
