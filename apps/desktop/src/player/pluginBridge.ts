import { setPlayerApi, usePluginHost } from "@/plugins/host";
import type { PlaybackEvent } from "@/plugins/types";
import { usePlayer } from "./playerStore";

/**
 * Connects the player to the plugin host: hands plugins a control handle and turns
 * store changes into the play / pause / seek / progress / ended events that scrobblers,
 * presence and remote-control plugins listen to. Imported once at start-up.
 */
export function connectPlayerToPlugins() {
  const player = usePlayer;
  setPlayerApi({
    getState: () => {
      const s = player.getState();
      return {
        current: s.current,
        isPlaying: s.isPlaying,
        position: s.position,
        duration: s.duration,
        volume: s.volume,
        queue: s.queue,
        index: s.index,
      };
    },
    toggle: () => player.getState().toggle(),
    next: () => player.getState().next(),
    previous: () => player.getState().previous(),
    seek: (s) => player.getState().seek(s),
    setVolume: (v) => player.getState().setVolume(v),
    playTracks: (tracks, start) => player.getState().playQueue(tracks, start),
    enqueue: (track) => player.getState().addToQueue(track),
  });

  const emit = (event: PlaybackEvent) => usePluginHost.getState().emitPlayback(event);
  let last = player.getState();
  let lastProgressAt = 0;

  return player.subscribe((s) => {
    const prev = last;
    last = s;

    if (s.current?.id !== prev.current?.id) {
      // A track that ran to its end is reported before the next one loads.
      emit({ kind: "track", track: s.current });
      return;
    }
    if (s.isPlaying !== prev.isPlaying) {
      emit({ kind: s.isPlaying ? "play" : "pause", track: s.current, position: s.position });
    }
    if (s.current && s.isPlaying && s.position !== prev.position) {
      // A jump of more than a few seconds is a seek; ordinary ticks become ~1 Hz progress.
      const jumped = Math.abs(s.position - prev.position) > 3;
      const now = Date.now();
      if (jumped) {
        emit({ kind: "seek", track: s.current, position: s.position, duration: s.duration });
      } else if (now - lastProgressAt >= 1000) {
        lastProgressAt = now;
        emit({ kind: "progress", track: s.current, position: s.position, duration: s.duration });
      }
    }
    if (
      s.current &&
      prev.current &&
      s.duration > 0 &&
      prev.isPlaying &&
      !s.isPlaying &&
      s.position >= s.duration - 1
    ) {
      emit({ kind: "ended", track: s.current, position: s.position, duration: s.duration });
    }
  });
}
