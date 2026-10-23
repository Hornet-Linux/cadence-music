import { usePlayer } from "@/player/playerStore";
import type { PlaybackEvent, PluginContext } from "../../types";
import type { RemoteState } from "./types";

const PROGRESS_EVERY_MS = 5000;
const MAX_QUEUE = 200;

/** The player's state in the form the relay carries (the queue is cut to a window around the current track). */
export function snapshot(ctx: PluginContext, now = Date.now()): Omit<RemoteState, "updatedAt"> & { updatedAt: number } {
  const s = ctx.player.getState();
  let queue = s.queue;
  let index = s.index;
  if (queue.length > MAX_QUEUE) {
    const start = Math.max(0, Math.min(index - 20, queue.length - MAX_QUEUE));
    queue = queue.slice(start, start + MAX_QUEUE);
    index -= start;
  }
  return { track: s.current, isPlaying: s.isPlaying, position: s.position, duration: s.duration, volume: s.volume, queue, index, updatedAt: now };
}

export interface Reporter {
  stop: () => void;
  sendNow: () => void;
}

/**
 * Reports this player's state to the relay: straight away when something changes, and about every five seconds
 * while playing, so other devices can show progress without the server being flooded.
 */
export function startReporter(ctx: PluginContext, post: (state: RemoteState) => Promise<void>, isOnline: () => boolean): Reporter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent = 0;

  const flush = () => {
    timer = null;
    if (!isOnline()) return;
    lastSent = Date.now();
    void post(snapshot(ctx)).catch(() => undefined);
  };
  const schedule = (delay: number) => {
    if (timer) return;
    timer = setTimeout(flush, delay);
  };

  const offPlayback = ctx.onPlayback((e: PlaybackEvent) => {
    if (e.kind === "progress") {
      if (Date.now() - lastSent >= PROGRESS_EVERY_MS) schedule(0);
      return;
    }
    if (e.kind === "ended") return;
    schedule(150);
  });
  let volume = usePlayer.getState().volume;
  let queue = usePlayer.getState().queue;
  const offVolume = usePlayer.subscribe((s) => {
    if (s.volume !== volume) {
      volume = s.volume;
      schedule(300);
    }
    // Adding or removing queue entries is not a playback event, but other devices show the queue.
    if (s.queue !== queue) {
      queue = s.queue;
      schedule(500);
    }
  });
  return {
    sendNow: () => {
      if (timer) clearTimeout(timer);
      flush();
    },
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      offPlayback();
      offVolume();
    },
  };
}
