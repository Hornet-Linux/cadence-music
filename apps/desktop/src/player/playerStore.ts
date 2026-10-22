import { create } from "zustand";
import type { Track } from "@/shared/types";
import { usePluginHost } from "@/plugins/host";
import type { ExternalPlayback } from "@/plugins/types";

type RepeatMode = "off" | "all" | "one";

interface PlayerState {
  queue: Track[];
  index: number;
  current: Track | null;
  isPlaying: boolean;
  /** Current playback position in seconds. */
  position: number;
  /** Track duration in seconds. */
  duration: number;
  volume: number;
  /** Temporary volume multiplier, e.g. lowered while the DJ talks. Not shown in the UI. */
  duck: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Set when no audio source could play the current track. */
  unresolved: boolean;

  playQueue: (tracks: Track[], startIndex?: number) => Promise<void>;
  playTrack: (track: Track) => Promise<void>;
  /** Append to the queue (starts playing if nothing is loaded). */
  addToQueue: (track: Track) => void;
  /** Play the queue entry at `index`. */
  jumpTo: (index: number) => Promise<void>;
  removeFromQueue: (index: number) => void;
  /** Restore a saved queue without starting playback. */
  restore: (saved: { queue: Track[]; index: number; position?: number }) => void;
  toggle: () => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  setDuck: (factor: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
}

// Plain media (server, local files) plays through one shared <audio> element.
// Sources with their own player (Spotify, Apple Music) hand back an
// ExternalPlayback handle instead; exactly one backend is active at a time.
const audio = new Audio();
audio.preload = "auto";

type Backend = { kind: "none" } | { kind: "html" } | { kind: "external"; handle: ExternalPlayback; unsubscribe: () => void };

const ignore = () => undefined;

export const usePlayer = create<PlayerState>((set, get) => {
  let backend: Backend = { kind: "none" };
  // Bumped on every load so a slow resolve can't override a newer selection.
  let loadSeq = 0;
  // Position to resume a restored track at once it is first played.
  let pendingSeek = 0;

  const effectiveVolume = () => (get().muted ? 0 : get().volume * get().duck);

  async function releaseBackend() {
    const previous = backend;
    backend = { kind: "none" };
    if (previous.kind === "external") {
      previous.unsubscribe();
      await previous.handle.stop().catch(ignore);
    } else if (previous.kind === "html") {
      audio.pause();
      audio.removeAttribute("src");
    }
  }

  async function startPlaying() {
    try {
      if (backend.kind === "html") await audio.play();
      else if (backend.kind === "external") await backend.handle.play();
      else return;
      set({ isPlaying: true });
    } catch {
      set({ isPlaying: false });
    }
  }

  async function load(track: Track | null, autoplay: boolean) {
    const seq = ++loadSeq;
    usePluginHost.getState().emitNowPlaying(track);
    await releaseBackend();
    if (seq !== loadSeq) return;

    if (!track) {
      set({ current: null, isPlaying: false, position: 0, duration: 0, unresolved: false });
      return;
    }
    set({ current: track, isPlaying: false, position: 0, duration: track.durationSec ?? 0, unresolved: false });

    const resolved = await usePluginHost.getState().resolveAudio(track);
    if (seq !== loadSeq) {
      // The user picked something else while this was resolving.
      if (resolved && typeof resolved !== "string") void resolved.stop().catch(ignore);
      return;
    }
    if (!resolved) {
      set({ unresolved: true });
      return;
    }

    if (typeof resolved === "string") {
      backend = { kind: "html" };
      audio.src = resolved;
    } else {
      const handle = resolved;
      const unsubscribe = handle.subscribe((e) => {
        if (backend.kind !== "external" || backend.handle !== handle) return;
        const patch: Partial<PlayerState> = {};
        if (e.position !== undefined) patch.position = e.position;
        if (e.duration !== undefined && e.duration > 0) patch.duration = e.duration;
        if (e.playing !== undefined) patch.isPlaying = e.playing;
        if (Object.keys(patch).length > 0) set(patch);
        if (e.ended) void get().next();
      });
      backend = { kind: "external", handle, unsubscribe };
      await handle.setVolume(effectiveVolume()).catch(ignore);
    }
    if (autoplay) await startPlaying();
  }

  audio.volume = 0.8;
  audio.addEventListener("timeupdate", () => {
    if (backend.kind === "html") set({ position: audio.currentTime });
  });
  audio.addEventListener("durationchange", () => {
    if (backend.kind === "html" && Number.isFinite(audio.duration)) set({ duration: audio.duration });
  });
  audio.addEventListener("ended", () => {
    if (backend.kind === "html") void get().next();
  });

  return {
    queue: [],
    index: -1,
    current: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 0.8,
    duck: 1,
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

    addToQueue(track) {
      const { queue, current } = get();
      if (!current) {
        void get().playQueue([...queue, track], queue.length);
        return;
      }
      set({ queue: [...queue, track] });
    },

    async jumpTo(index) {
      const { queue } = get();
      if (index < 0 || index >= queue.length) return;
      set({ index });
      await load(queue[index], true);
    },

    removeFromQueue(index) {
      const { queue, index: currentIndex } = get();
      if (index < 0 || index >= queue.length || index === currentIndex) return;
      set({
        queue: queue.filter((_, i) => i !== index),
        index: index < currentIndex ? currentIndex - 1 : currentIndex,
      });
    },

    restore({ queue, index, position }) {
      if (queue.length === 0 || get().current) return;
      const i = Math.min(Math.max(0, index), queue.length - 1);
      pendingSeek = position && position > 0 ? position : 0;
      set({
        queue,
        index: i,
        current: queue[i],
        position: pendingSeek,
        duration: queue[i].durationSec ?? 0,
        isPlaying: false,
      });
    },

    toggle() {
      const { current } = get();
      if (!current) return;
      if (backend.kind === "none") {
        // Restored or unresolved: load the track now, then pick up where it was.
        const resumeAt = pendingSeek;
        pendingSeek = 0;
        void load(current, true).then(() => {
          if (resumeAt > 0 && get().current?.id === current.id) get().seek(resumeAt);
        });
        return;
      }
      if (get().isPlaying) {
        if (backend.kind === "html") audio.pause();
        else void backend.handle.pause().catch(ignore);
        set({ isPlaying: false });
      } else {
        void startPlaying();
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
        get().seek(0);
        return;
      }
      const prevIndex = index - 1 < 0 ? 0 : index - 1;
      set({ index: prevIndex });
      await load(queue[prevIndex], true);
    },

    seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      if (backend.kind === "html") audio.currentTime = seconds;
      else if (backend.kind === "external") void backend.handle.seek(seconds).catch(ignore);
      set({ position: seconds });
    },

    setVolume(v) {
      const volume = Math.min(1, Math.max(0, v));
      set({ volume, muted: false });
      audio.volume = volume * get().duck;
      audio.muted = false;
      if (backend.kind === "external") void backend.handle.setVolume(effectiveVolume()).catch(ignore);
    },

    setDuck(factor) {
      set({ duck: Math.min(1, Math.max(0, factor)) });
      audio.volume = get().volume * get().duck;
      if (backend.kind === "external") void backend.handle.setVolume(effectiveVolume()).catch(ignore);
    },

    toggleMute() {
      const muted = !get().muted;
      set({ muted });
      audio.muted = muted;
      if (backend.kind === "external") void backend.handle.setVolume(effectiveVolume()).catch(ignore);
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
