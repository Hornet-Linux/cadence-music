import { create } from "zustand";
import type { Track } from "@/shared/types";
import { usePluginHost } from "@/plugins/host";

type RepeatMode = "off" | "all" | "one";

interface PlayerState {
  queue: Track[];
  index: number;
  current: Track | null;
  isPlaying: boolean;
  /** Current playback position in seconds. */
  position: number;
  /** Track duration in seconds (from the media element when available). */
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Set when a track could not be resolved to a playable stream. */
  unresolved: boolean;

  playQueue: (tracks: Track[], startIndex?: number) => Promise<void>;
  playTrack: (track: Track) => Promise<void>;
  toggle: () => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
}

// A single shared media element drives playback.
const audio = new Audio();
audio.preload = "auto";

export const usePlayer = create<PlayerState>((set, get) => {
  async function load(track: Track | null, autoplay: boolean) {
    usePluginHost.getState().emitNowPlaying(track);
    if (!track) {
      audio.removeAttribute("src");
      set({ current: null, isPlaying: false, position: 0, duration: 0, unresolved: false });
      return;
    }
    const url = await usePluginHost.getState().resolveAudio(track);
    if (!url) {
      audio.removeAttribute("src");
      set({ current: track, isPlaying: false, position: 0, duration: 0, unresolved: true });
      return;
    }
    audio.src = url;
    set({ current: track, position: 0, unresolved: false });
    if (autoplay) {
      try {
        await audio.play();
        set({ isPlaying: true });
      } catch {
        set({ isPlaying: false });
      }
    }
  }

  audio.addEventListener("timeupdate", () => set({ position: audio.currentTime }));
  audio.addEventListener("durationchange", () =>
    set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }),
  );
  audio.addEventListener("ended", () => void get().next());

  return {
    queue: [],
    index: -1,
    current: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: "off",
    unresolved: false,

    async playQueue(tracks, startIndex = 0) {
      if (tracks.length === 0) return;
      const index = Math.min(Math.max(0, startIndex), tracks.length - 1);
      set({ queue: tracks, index });
      await load(tracks[index], true);
    },

    async playTrack(track) {
      await get().playQueue([track], 0);
    },

    toggle() {
      const { current, isPlaying } = get();
      if (!current) return;
      if (isPlaying) {
        audio.pause();
        set({ isPlaying: false });
      } else {
        void audio.play().then(() => set({ isPlaying: true })).catch(() => undefined);
      }
    },

    async next() {
      const { queue, index, repeat, shuffle } = get();
      if (queue.length === 0) return;
      if (repeat === "one") return load(queue[index], true);
      let nextIndex: number;
      if (shuffle) {
        nextIndex = Math.floor(Math.random() * queue.length);
      } else {
        nextIndex = index + 1;
        if (nextIndex >= queue.length) {
          if (repeat === "all") nextIndex = 0;
          else {
            set({ isPlaying: false });
            return;
          }
        }
      }
      set({ index: nextIndex });
      await load(queue[nextIndex], true);
    },

    async previous() {
      const { queue, index, position } = get();
      if (queue.length === 0) return;
      // Restart the current track if more than 3s in, else go back one.
      if (position > 3) {
        audio.currentTime = 0;
        return;
      }
      const prevIndex = index - 1 < 0 ? 0 : index - 1;
      set({ index: prevIndex });
      await load(queue[prevIndex], true);
    },

    seek(seconds) {
      if (Number.isFinite(seconds)) audio.currentTime = seconds;
    },

    setVolume(v) {
      const volume = Math.min(1, Math.max(0, v));
      audio.volume = volume;
      audio.muted = false;
      set({ volume, muted: false });
    },

    toggleMute() {
      const muted = !get().muted;
      audio.muted = muted;
      set({ muted });
    },

    toggleShuffle() {
      set({ shuffle: !get().shuffle });
    },

    cycleRepeat() {
      const order: RepeatMode[] = ["off", "all", "one"];
      const nextMode = order[(order.indexOf(get().repeat) + 1) % order.length];
      set({ repeat: nextMode });
    },
  };
});
