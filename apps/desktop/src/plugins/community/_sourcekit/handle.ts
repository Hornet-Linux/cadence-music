import type { ExternalPlayback, ExternalPlaybackEvent } from "@/plugins/types";

/**
 * Playback for spoken-word and live sources through their own <audio> element, handed to the player as an
 * ExternalPlayback. It adds what the shared element can't: starting at a saved position, a playback speed,
 * books made of several files, HLS radio, and a sleep timer that fades out. The host still drives play, pause,
 * seek and volume through the usual handle methods.
 */

export interface Segment {
  url: string;
  /** Where this file starts within the whole recording, in seconds. */
  startOffset: number;
  duration: number;
}

/** The slice of HTMLAudioElement used here (tests substitute a fake). */
export interface AudioLike {
  src: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  volume: number;
  playbackRate: number;
  preservesPitch?: boolean;
  play: () => Promise<void>;
  pause: () => void;
  removeAttribute: (name: string) => void;
  load?: () => void;
  canPlayType?: (type: string) => string;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface HlsLike {
  loadSource: (url: string) => void;
  attachMedia: (media: unknown) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  destroy: () => void;
}
export interface HlsModule {
  isSupported: () => boolean;
  create: () => HlsLike;
  events: { MANIFEST_PARSED: string; ERROR: string };
}

export type SleepTimer = { kind: "minutes"; until: number } | { kind: "position"; at: number };

export interface TickInfo {
  position: number;
  duration: number;
  playing: boolean;
  reason: "tick" | "play" | "pause" | "seek" | "end";
}

export interface HandleOptions {
  segments: Segment[];
  /** Whole-recording length when the files' own durations are not trusted or known. */
  totalDuration?: number;
  /** Stream is an HLS playlist. */
  hls?: boolean;
  startAt?: number;
  rate?: number;
  createAudio?: () => AudioLike;
  loadHls?: () => Promise<HlsModule | null>;
  now?: () => number;
  onTick?: (info: TickInfo) => void;
  /** The handle is being released; `position` is where listening stopped. */
  onStop?: (position: number) => void;
  onError?: (reason: string) => void;
}

export interface MediaHandle extends ExternalPlayback {
  readonly rate: number;
  setRate: (rate: number) => void;
  readonly sleep: SleepTimer | null;
  setSleep: (timer: SleepTimer | null) => void;
  onSleepChange: (listener: (timer: SleepTimer | null) => void) => () => void;
  position: () => number;
}

/** Index of the file that contains `position`. */
export function segmentIndexFor(segments: Segment[], position: number): number {
  let found = 0;
  for (let i = 0; i < segments.length; i++) if (segments[i].startOffset <= position + 0.001) found = i;
  return found;
}

/** Volume multiplier while the sleep timer winds down: full until the last `fadeSec`, then a straight ramp to near silence. */
export function fadeFactor(remainingSec: number, fadeSec = 20): number {
  if (remainingSec >= fadeSec) return 1;
  return Math.max(0.03, remainingSec / fadeSec);
}

export function createMediaHandle(opts: HandleOptions): MediaHandle {
  const segments = opts.segments.length > 0 ? opts.segments : [];
  const audio: AudioLike = opts.createAudio ? opts.createAudio() : (new Audio() as unknown as AudioLike);
  const now = opts.now ?? Date.now;
  audio.preservesPitch = true;
  let rate = opts.rate && opts.rate > 0 ? opts.rate : 1;
  audio.playbackRate = rate;
  let baseVolume = 1;
  let fade = 1;
  let index = 0;
  let pendingSeek = 0;
  let stopped = false;
  let sleep: SleepTimer | null = null;
  const sleepListeners = new Set<(t: SleepTimer | null) => void>();
  const listeners = new Set<(e: ExternalPlaybackEvent) => void>();
  let hls: HlsLike | null = null;
  let ready: Promise<void> = Promise.resolve();

  const total = opts.totalDuration ?? (segments.length ? segments[segments.length - 1].startOffset + segments[segments.length - 1].duration : 0);
  const emit = (e: ExternalPlaybackEvent) => {
    for (const l of listeners) l(e);
  };
  const position = () => (segments[index]?.startOffset ?? 0) + (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
  const durationNow = () => (total > 0 ? total : Number.isFinite(audio.duration) ? audio.duration : 0);
  const applyVolume = () => {
    audio.volume = Math.min(1, Math.max(0, baseVolume * fade));
  };
  const tick = (reason: TickInfo["reason"], playing = !audio.paused) => opts.onTick?.({ position: position(), duration: durationNow(), playing, reason });

  function setSource(i: number, local: number) {
    index = i;
    pendingSeek = local;
    const url = segments[i].url;
    if (opts.hls) {
      ready = attachHls(url);
      // A failure surfaces when playing is attempted; until then it must not count as unhandled.
      ready.catch(() => undefined);
    } else {
      audio.src = url;
    }
  }

  async function attachHls(url: string): Promise<void> {
    if (audio.canPlayType?.("application/vnd.apple.mpegurl")) {
      audio.src = url;
      return;
    }
    const mod = await (opts.loadHls ?? defaultLoadHls)();
    if (!mod || !mod.isSupported()) {
      opts.onError?.("This browser can't play this live stream format.");
      throw new Error("hls unsupported");
    }
    const instance = mod.create();
    hls = instance;
    await new Promise<void>((resolve, reject) => {
      instance.on(mod.events.MANIFEST_PARSED, () => resolve());
      instance.on(mod.events.ERROR, (...args: unknown[]) => {
        const data = args[1] as { fatal?: boolean } | undefined;
        if (data?.fatal) {
          opts.onError?.("The live stream stopped.");
          reject(new Error("hls fatal"));
          emit({ playing: false });
        }
      });
      instance.loadSource(url);
      instance.attachMedia(audio);
    });
  }

  const onLoadedMetadata = () => {
    if (pendingSeek > 0) {
      audio.currentTime = pendingSeek;
      pendingSeek = 0;
    }
  };
  const onTimeUpdate = () => {
    if (stopped) return;
    const pos = position();
    checkSleep(pos);
    emit({ position: pos, duration: durationNow() });
    tick("tick");
  };
  const onEnded = () => {
    if (stopped) return;
    if (index + 1 < segments.length) {
      setSource(index + 1, 0);
      void ready.then(() => audio.play()).catch(() => emit({ playing: false }));
      return;
    }
    emit({ position: durationNow() || position(), playing: false, ended: true });
    tick("end", false);
  };
  const onError = () => {
    if (stopped) return;
    opts.onError?.("This couldn't be played.");
    emit({ playing: false });
  };
  const onDuration = () => {
    if (total <= 0 && Number.isFinite(audio.duration)) emit({ duration: audio.duration });
  };
  audio.addEventListener("loadedmetadata", onLoadedMetadata);
  audio.addEventListener("timeupdate", onTimeUpdate);
  audio.addEventListener("ended", onEnded);
  audio.addEventListener("error", onError);
  audio.addEventListener("durationchange", onDuration);

  function checkSleep(pos: number) {
    if (!sleep) {
      if (fade !== 1) {
        fade = 1;
        applyVolume();
      }
      return;
    }
    const remaining = sleep.kind === "minutes" ? (sleep.until - now()) / 1000 : (sleep.at - pos) / rate;
    fade = fadeFactor(remaining);
    applyVolume();
    if (remaining <= 0) {
      audio.pause();
      setSleep(null);
      emit({ playing: false });
      tick("pause", false);
    }
  }

  function setSleep(timer: SleepTimer | null) {
    sleep = timer;
    if (!timer) {
      fade = 1;
      applyVolume();
    }
    for (const l of sleepListeners) l(timer);
  }

  if (segments.length > 0) {
    const start = Math.max(0, opts.startAt ?? 0);
    const first = segmentIndexFor(segments, start);
    setSource(first, start - segments[first].startOffset);
  }

  return {
    get rate() {
      return rate;
    },
    setRate(next) {
      if (!(next > 0.1 && next <= 4)) return;
      rate = next;
      audio.playbackRate = next;
    },
    get sleep() {
      return sleep;
    },
    setSleep,
    onSleepChange(listener) {
      sleepListeners.add(listener);
      return () => sleepListeners.delete(listener);
    },
    position,

    async play() {
      await ready;
      await audio.play();
      emit({ playing: true, duration: durationNow() || undefined });
      tick("play", true);
    },
    async pause() {
      audio.pause();
      emit({ playing: false });
      tick("pause", false);
    },
    async seek(seconds) {
      if (!Number.isFinite(seconds) || segments.length === 0) return;
      const target = Math.max(0, total > 0 ? Math.min(seconds, total) : seconds);
      const i = segmentIndexFor(segments, target);
      const local = target - segments[i].startOffset;
      if (i === index && !pendingSeek) {
        audio.currentTime = local;
      } else {
        const wasPlaying = !audio.paused;
        setSource(i, local);
        if (wasPlaying) await ready.then(() => audio.play()).catch(() => undefined);
      }
      emit({ position: target });
      tick("seek");
    },
    async setVolume(volume) {
      baseVolume = volume;
      applyVolume();
    },
    async stop() {
      if (stopped) return;
      const last = position();
      stopped = true;
      audio.pause();
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("durationchange", onDuration);
      hls?.destroy();
      hls = null;
      audio.removeAttribute("src");
      try {
        audio.load?.();
      } catch {
        // Some environments don't implement load().
      }
      listeners.clear();
      opts.onStop?.(last);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** hls.js is only fetched when a live HLS station is played. */
async function defaultLoadHls(): Promise<HlsModule | null> {
  try {
    const { default: Hls } = await import("hls.js");
    return {
      isSupported: () => Hls.isSupported(),
      create: () => new Hls({ lowLatencyMode: false, enableWorker: true }) as unknown as HlsLike,
      events: { MANIFEST_PARSED: Hls.Events.MANIFEST_PARSED, ERROR: Hls.Events.ERROR },
    };
  } catch {
    return null;
  }
}