import { usePlayer } from "@/player/playerStore";

type Event = "start" | "stop";

interface Snapshot {
  current: { id: string } | null;
  isPlaying: boolean;
  position: number;
  duration: number;
}

/**
 * Turns player state changes into "start" and "stop" reports for one music
 * service: "start" when one of its tracks begins playing, "stop" when it ends,
 * is skipped or replaced (with how far it got and how long it is, so the
 * server can tell a real listen from a skip). Pausing is not a stop. Tracks of
 * other sources are never reported. Feed it every (state, previous state) pair.
 */
export function createPlaybackReporter(
  itemIdOf: (track: { id: string }) => string | null,
  send: (event: Event, itemId: string, positionSec: number, durationSec: number) => void,
) {
  let reporting: string | null = null;

  return function onPlayerChange(state: Snapshot, prev: Snapshot) {
    const itemId = state.current ? itemIdOf(state.current) : null;
    const sameTrack = state.current?.id === prev.current?.id;

    const ended = !state.isPlaying && prev.isPlaying && state.duration > 0 && state.position >= state.duration - 1;
    if (reporting && (reporting !== itemId || ended)) {
      send("stop", reporting, sameTrack ? state.position : prev.position, sameTrack ? state.duration : prev.duration);
      reporting = null;
    }

    if (!itemId || !state.isPlaying || reporting === itemId) return;
    reporting = itemId;
    send("start", itemId, state.position, state.duration);
  };
}

/** Subscribe a reporter to the player. Returns the unsubscribe function. */
export function watchPlayer(onChange: ReturnType<typeof createPlaybackReporter>): () => void {
  return usePlayer.subscribe(onChange);
}