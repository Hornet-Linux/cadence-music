import { create } from "zustand";
import type { Track } from "@/shared/types";
import { usePluginHost } from "@/plugins/host";
import type { ExternalPlayback } from "@/plugins/types";
import { audioGraph } from "./audioGraph";
import { Deck } from "./deck";
import { crossfadeGains, planTransition, type TransitionInput } from "./transition";
import { useTuning } from "./tuning";

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
  /**
   * What is playing the current track: `html` (plain media, which honours speed, pitch, crossfade and
   * gapless), `external` (a vendor player such as Spotify, which ignores them) or `none`.
   */
  engine: "html" | "external" | "none";

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

// Plain media (server, local files) plays through <audio> elements managed by the deck:
// one is playing, and a second holds the next track (pre-buffered for gapless, or blending
// in during a crossfade). Sources with their own player (Spotify, Apple Music) hand back an
// ExternalPlayback handle instead; exactly one backend is active at a time. Audio effects,
// crossfade, gapless, speed and pitch only apply to the <audio> backend: an external player
// decodes and outputs audio inside the vendor's SDK, which a web page cannot tap or retime.
type Backend = { kind: "none" } | { kind: "html" } | { kind: "external"; handle: ExternalPlayback; unsubscribe: () => void };

/** Sources whose tracks play in a vendor SDK, never as a plain URL: do not pre-resolve them. */
const EXTERNAL_SOURCES = new Set(["spotify", "apple-music"]);

const ignore = () => undefined;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

interface Preloaded {
  trackId: string;
  url: string;
  el: HTMLAudioElement;
}

interface Fade {
  from: HTMLAudioElement;
  to: HTMLAudioElement;
  toUrl: string;
  track: Track;
  index: number;
  startedAt: number;
  durationMs: number;
  gains: { out: number; in: number };
  timer: ReturnType<typeof setInterval>;
}

export const usePlayer = create<PlayerState>((set, get) => {
  const deck = new Deck();
  let backend: Backend = { kind: "none" };
  let audio: HTMLAudioElement;
  let currentUrl: string | null = null;
  // Bumped on every load so a slow resolve can't override a newer selection.
  let loadSeq = 0;
  // Position to resume a restored track at once it is first played.
  let pendingSeek = 0;

  // Gapless / crossfade bookkeeping (plain audio only).
  let preloaded: Preloaded | null = null;
  let preloading: string | null = null;
  let fade: Fade | null = null;
  let startingFade = false;
  /** Tracks that cannot be pre-resolved (they play in an SDK), so the normal path is used. */
  const noPreload = new Set<string>();
  /** Next shuffle pick, fixed once chosen so pre-buffering matches what plays next. */
  let queuedNext: number | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const tuning = () => useTuning.getState();
  const effectiveVolume = () => (get().muted ? 0 : get().volume * get().duck * tuning().masterGain);

  // ---- element output -----------------------------------------------------

  function applyOutput(el: HTMLAudioElement) {
    const t = tuning();
    el.muted = get().muted;
    let gain = 1;
    if (fade) gain = el === fade.from ? fade.gains.out : el === fade.to ? fade.gains.in : 1;
    el.volume = clamp01(get().volume * get().duck * t.masterGain * gain);
    // defaultPlaybackRate survives the src change that resets playbackRate.
    el.defaultPlaybackRate = t.rate;
    el.playbackRate = t.rate;
    el.preservesPitch = t.preservePitch;
  }

  function refreshOutputs() {
    applyOutput(audio);
    if (fade) applyOutput(fade.to);
    if (backend.kind === "external") void backend.handle.setVolume(effectiveVolume()).catch(ignore);
  }

  // ---- next-track planning ------------------------------------------------

  function peekNext(): number | null {
    const { queue, index, repeat, shuffle } = get();
    if (queue.length === 0 || repeat === "one") return null;
    if (shuffle) {
      if (queuedNext === null || queuedNext >= queue.length) queuedNext = Math.floor(Math.random() * queue.length);
      return queuedNext;
    }
    const n = index + 1;
    if (n >= queue.length) return repeat === "all" ? 0 : null;
    return n;
  }

  function canPlanFor(track: Track | undefined): track is Track {
    return !!track && !noPreload.has(track.id) && !EXTERNAL_SOURCES.has(track.source ?? "");
  }

  function dropPreload() {
    if (preloaded) deck.release(preloaded.el);
    preloaded = null;
  }

  function cancelFade() {
    if (!fade) return;
    clearInterval(fade.timer);
    deck.release(fade.to);
    fade = null;
  }

  // ---- backend lifecycle --------------------------------------------------

  async function releaseBackend() {
    const previous = backend;
    backend = { kind: "none" };
    set({ engine: "none" });
    stopTicker();
    cancelFade();
    dropPreload();
    currentUrl = null;
    if (previous.kind === "external") {
      previous.unsubscribe();
      await previous.handle.stop().catch(ignore);
    } else if (previous.kind === "html") {
      deck.release(audio);
    }
  }

  async function startPlaying() {
    try {
      if (backend.kind === "html") {
        // A captured element is silent while its audio context sleeps.
        if (deck.isRouted(audio)) await audioGraph.resume();
        await audio.play();
        startTicker();
      } else if (backend.kind === "external") await backend.handle.play();
      else return;
      set({ isPlaying: true });
    } catch {
      set({ isPlaying: false });
    }
  }

  async function load(track: Track | null, autoplay: boolean) {
    const seq = ++loadSeq;
    usePluginHost.getState().emitNowPlaying(track);
    // A pre-buffered next track is kept: claim it before the old one is released.
    const keep = track && preloaded?.trackId === track.id ? preloaded : null;
    if (keep) preloaded = null;
    await releaseBackend();
    queuedNext = null;
    if (seq !== loadSeq) {
      if (keep) deck.release(keep.el);
      return;
    }

    if (!track) {
      set({ current: null, isPlaying: false, position: 0, duration: 0, unresolved: false });
      return;
    }
    set({ current: track, isPlaying: false, position: 0, duration: track.durationSec ?? 0, unresolved: false });

    let element: HTMLAudioElement | null = null;
    let url: string | null = null;
    let handle: ExternalPlayback | null = null;
    if (keep) {
      element = keep.el;
      url = keep.url;
    } else {
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
        url = resolved;
        element = await deck.prepare(resolved);
        if (seq !== loadSeq) {
          deck.release(element);
          return;
        }
      } else {
        handle = resolved;
      }
    }

    if (element && url) {
      backend = { kind: "html" };
      set({ engine: "html" });
      audio = element;
      currentUrl = url;
      applyOutput(audio);
    } else if (handle) {
      const h = handle;
      const unsubscribe = h.subscribe((e) => {
        if (backend.kind !== "external" || backend.handle !== h) return;
        const patch: Partial<PlayerState> = {};
        if (e.position !== undefined) patch.position = e.position;
        if (e.duration !== undefined && e.duration > 0) patch.duration = e.duration;
        if (e.playing !== undefined) patch.isPlaying = e.playing;
        if (Object.keys(patch).length > 0) set(patch);
        if (e.ended) void onTrackEnded();
      });
      backend = { kind: "external", handle: h, unsubscribe };
      set({ engine: "external" });
      await h.setVolume(effectiveVolume()).catch(ignore);
    }
    if (autoplay) await startPlaying();
  }

  // ---- track end ----------------------------------------------------------

  /** A track ran out by itself: stop if asked to (sleep timer), else advance. */
  async function onTrackEnded() {
    if (tuning().stopAfterTrack) {
      tuning().set({ stopAfterTrack: false });
      set({ isPlaying: false });
      return;
    }
    await get().next();
  }

  // ---- gapless and crossfade ---------------------------------------------

  function startTicker() {
    if (!ticker) ticker = setInterval(tick, 100);
  }
  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  function tick() {
    if (backend.kind !== "html" || !get().isPlaying || fade) return;
    const t = tuning();
    if (t.holdTrack) {
      // A plugin is looping a section: keep the position fresh (media events only come about 4 times a second) and plan nothing.
      if (Math.abs(get().position - audio.currentTime) > 0.001) set({ position: audio.currentTime });
      return;
    }
    if (t.crossfadeSec <= 0 && !t.gapless) return;
    const nextIndex = peekNext();
    const next = nextIndex === null ? undefined : get().queue[nextIndex];
    const ready = !!next && preloaded?.trackId === next.id;
    const input: TransitionInput = {
      position: audio.currentTime,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      rate: audio.playbackRate || 1,
      crossfadeSec: t.crossfadeSec,
      gapless: t.gapless,
      hasNext: canPlanFor(next),
      next: ready ? "ready" : next && preloading === next.id ? "loading" : "none",
      crossfading: startingFade,
      stopAfterTrack: t.stopAfterTrack,
    };
    const plan = planTransition(input);
    if (plan.kind === "preload" && nextIndex !== null) void preloadNext(nextIndex);
    else if (plan.kind === "crossfade") void startCrossfade(plan.seconds);
    else if (plan.kind === "switch") void get().next();
  }

  async function preloadNext(index: number) {
    const track = get().queue[index];
    if (!canPlanFor(track) || preloading === track.id || preloaded?.trackId === track.id) return;
    preloading = track.id;
    const seq = loadSeq;
    try {
      const resolved = await usePluginHost.getState().resolveAudio(track);
      if (seq !== loadSeq || backend.kind !== "html") {
        if (resolved && typeof resolved !== "string") void resolved.stop().catch(ignore);
        return;
      }
      if (typeof resolved !== "string") {
        // Not plain media (or unplayable): the normal load path will deal with it.
        if (resolved) void resolved.stop().catch(ignore);
        noPreload.add(track.id);
        return;
      }
      const el = await deck.prepare(resolved);
      if (seq !== loadSeq || backend.kind !== "html") {
        deck.release(el);
        return;
      }
      dropPreload();
      preloaded = { trackId: track.id, url: resolved, el };
    } catch {
      noPreload.add(track.id);
    } finally {
      preloading = null;
    }
  }

  async function startCrossfade(requestedSec: number) {
    if (startingFade || fade || backend.kind !== "html") return;
    const index = peekNext();
    const next = index === null ? undefined : get().queue[index];
    if (!canPlanFor(next)) return;
    startingFade = true;
    const seq = loadSeq;
    let incoming: HTMLAudioElement | null = null;
    try {
      let url: string;
      if (preloaded?.trackId === next.id) {
        incoming = preloaded.el;
        url = preloaded.url;
        preloaded = null;
      } else {
        const resolved = await usePluginHost.getState().resolveAudio(next);
        if (seq !== loadSeq) {
          if (resolved && typeof resolved !== "string") void resolved.stop().catch(ignore);
          return;
        }
        if (typeof resolved !== "string") {
          if (resolved) void resolved.stop().catch(ignore);
          noPreload.add(next.id);
          return;
        }
        url = resolved;
        incoming = await deck.prepare(resolved);
        if (seq !== loadSeq) {
          deck.release(incoming);
          return;
        }
      }
      const rate = audio.playbackRate || 1;
      const left = Number.isFinite(audio.duration) ? Math.max(0, (audio.duration - audio.currentTime) / rate) : requestedSec;
      const seconds = Math.max(0.5, Math.min(requestedSec, left));
      const f: Fade = {
        from: audio,
        to: incoming,
        toUrl: url,
        track: next,
        index: index!,
        startedAt: performance.now(),
        durationMs: seconds * 1000,
        gains: { out: 1, in: 0 },
        timer: setInterval(stepFade, 40),
      };
      fade = f;
      applyOutput(incoming);
      try {
        await incoming.play();
      } catch {
        // The browser refused (autoplay) or the file is bad: leave the old track alone.
        clearInterval(f.timer);
        if (fade === f) fade = null;
        deck.release(incoming);
        noPreload.add(next.id);
        return;
      }
      if (seq !== loadSeq) {
        // Superseded while starting; whoever bumped loadSeq already cancelled the fade.
        return;
      }
      incoming = null;
    } catch {
      noPreload.add(next.id);
    } finally {
      if (incoming && fade?.to !== incoming) deck.release(incoming);
      startingFade = false;
    }
  }

  function stepFade() {
    const f = fade;
    if (!f) return;
    const progress = (performance.now() - f.startedAt) / f.durationMs;
    f.gains = crossfadeGains(progress);
    applyOutput(f.from);
    applyOutput(f.to);
    if (progress >= 1) completeFade();
  }

  /** The blend is over (or cut short): the incoming track becomes the current one. */
  function completeFade() {
    const f = fade;
    if (!f) return;
    clearInterval(f.timer);
    fade = null;
    loadSeq++;
    queuedNext = null;
    deck.release(f.from);
    audio = f.to;
    currentUrl = f.toUrl;
    applyOutput(audio);
    set({
      index: f.index,
      current: f.track,
      position: audio.currentTime,
      duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (f.track.durationSec ?? 0),
      isPlaying: true,
      unresolved: false,
    });
    usePluginHost.getState().emitNowPlaying(f.track);
  }

  // ---- element events -----------------------------------------------------

  deck.onCreate((el) => {
    el.addEventListener("timeupdate", () => {
      if (el !== audio || backend.kind !== "html") return;
      set({ position: el.currentTime });
      // Timers are throttled in background tabs; media events are not.
      tick();
    });
    el.addEventListener("durationchange", () => {
      if (el === audio && backend.kind === "html" && Number.isFinite(el.duration)) set({ duration: el.duration });
    });
    // The system can pause or resume the element on its own (phone call, Siri, headphones
    // unplugged, another app taking audio focus). Keep `isPlaying` honest so the lock-screen
    // and notification buttons do the right thing. Our own pauses either set the flag
    // themselves or release the element first (backend "none"), so they are not affected.
    el.addEventListener("pause", () => {
      if (el !== audio || backend.kind !== "html" || fade) return;
      // Reaching the end also fires "pause"; the "ended" handler deals with that.
      if (el.ended) return;
      if (get().isPlaying) {
        stopTicker();
        set({ isPlaying: false });
      }
    });
    el.addEventListener("play", () => {
      if (el !== audio || backend.kind !== "html" || fade) return;
      // A late "play" event after we already paused again must not flip the state back.
      if (el.paused) return;
      if (!get().isPlaying) {
        startTicker();
        set({ isPlaying: true });
      }
    });
    el.addEventListener("ended", () => {
      if (el !== audio || backend.kind !== "html") return;
      if (fade) {
        // The outgoing track ran out mid-blend: finish handing over.
        completeFade();
        return;
      }
      void onTrackEnded();
    });
  });
  audio = deck.first();
  audio.volume = 0.8;

  // ---- audio effects ------------------------------------------------------

  audioGraph.setEffects(usePluginHost.getState().contributions.audioEffects);
  usePluginHost.subscribe((s, prev) => {
    if (s.contributions.audioEffects !== prev.contributions.audioEffects) {
      audioGraph.setEffects(s.contributions.audioEffects);
    }
  });
  if (typeof window !== "undefined") audioGraph.watchGestures();

  /** Effects were switched on while a track plays: move it to an element the graph can reach. */
  audioGraph.onWantedChange((wanted) => {
    if (wanted) void reroute();
  });

  async function reroute() {
    if (backend.kind !== "html" || !currentUrl || deck.isRouted(audio)) return;
    const seq = loadSeq;
    const url = currentUrl;
    const old = audio;
    const resume = old.currentTime;
    const wasPlaying = !old.paused;
    const el = await deck.prepare(url);
    if (seq !== loadSeq || backend.kind !== "html" || !deck.isRouted(el)) {
      deck.release(el);
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        el.removeEventListener("loadedmetadata", done);
        resolve();
      };
      el.addEventListener("loadedmetadata", done);
      setTimeout(done, 3000);
    });
    if (seq !== loadSeq || backend.kind !== "html") {
      deck.release(el);
      return;
    }
    try {
      el.currentTime = resume;
    } catch {
      // Not seekable yet; starts from the top.
    }
    applyOutput(el);
    audio = el;
    deck.release(old);
    if (wasPlaying) await startPlaying();
  }

  // Plugin knobs (speed, master gain...) take effect immediately.
  useTuning.subscribe((s, prev) => {
    if (s.rate !== prev.rate || s.preservePitch !== prev.preservePitch || s.masterGain !== prev.masterGain) {
      refreshOutputs();
    }
    if (s.crossfadeSec === 0 && !s.gapless && (prev.gapless || prev.crossfadeSec > 0)) dropPreload();
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
    engine: "none",

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
      queuedNext = null;
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
        completeFade();
        if (backend.kind === "html") audio.pause();
        else void backend.handle.pause().catch(ignore);
        stopTicker();
        set({ isPlaying: false });
      } else {
        void startPlaying();
      }
    },

    async next() {
      if (fade) {
        // The next track is already audible: just let it take over.
        completeFade();
        return;
      }
      const { queue, index, repeat } = get();
      if (queue.length === 0) return;
      if (repeat === "one") return load(queue[index], true);
      const nextIndex = peekNext();
      if (nextIndex === null) {
        set({ isPlaying: false });
        return;
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
      completeFade();
      const prevIndex = index - 1 < 0 ? 0 : index - 1;
      set({ index: prevIndex });
      await load(queue[prevIndex], true);
    },

    seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      completeFade();
      if (backend.kind === "html") audio.currentTime = seconds;
      else if (backend.kind === "external") void backend.handle.seek(seconds).catch(ignore);
      set({ position: seconds });
    },

    setVolume(v) {
      const volume = Math.min(1, Math.max(0, v));
      set({ volume, muted: false });
      refreshOutputs();
    },

    setDuck(factor) {
      set({ duck: Math.min(1, Math.max(0, factor)) });
      refreshOutputs();
    },

    toggleMute() {
      set({ muted: !get().muted });
      refreshOutputs();
    },

    toggleShuffle() {
      queuedNext = null;
      set({ shuffle: !get().shuffle });
    },

    cycleRepeat() {
      const order: RepeatMode[] = ["off", "all", "one"];
      const nextMode = order[(order.indexOf(get().repeat) + 1) % order.length];
      queuedNext = null;
      set({ repeat: nextMode });
    },
  };
});
