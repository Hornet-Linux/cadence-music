import type { ExternalPlayback, ExternalPlaybackEvent } from "@/plugins/types";

// Minimal typings and loader for Apple's MusicKit JS v3
// (https://developer.apple.com/documentation/musickitjs).

export interface MusicKitEvent {
  state?: number;
}

export interface MusicKitInstance {
  isAuthorized: boolean;
  authorize(): Promise<string>;
  unauthorize(): Promise<void>;
  api: { music<T>(path: string, params?: Record<string, unknown>): Promise<{ data: T }> };
  setQueue(options: Record<string, unknown>): Promise<unknown>;
  play(): Promise<void>;
  pause(): void | Promise<void>;
  stop(): void | Promise<void>;
  seekToTime(seconds: number): Promise<void>;
  volume: number;
  currentPlaybackTime: number;
  currentPlaybackDuration: number;
  addEventListener(name: string, listener: (event: MusicKitEvent) => void): void;
  removeEventListener(name: string, listener: (event: MusicKitEvent) => void): void;
}

interface MusicKitGlobal {
  configure(config: { developerToken: string; app: { name: string; build: string } }): Promise<MusicKitInstance>;
  getInstance(): MusicKitInstance;
  PlaybackStates: Record<string, number>;
}

declare global {
  interface Window {
    MusicKit?: MusicKitGlobal;
  }
}

const SCRIPT_URL = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
let loading: Promise<MusicKitGlobal> | null = null;

function loadMusicKit(): Promise<MusicKitGlobal> {
  if (window.MusicKit) return Promise.resolve(window.MusicKit);
  if (!loading) {
    loading = new Promise<MusicKitGlobal>((resolve, reject) => {
      const done = () => (window.MusicKit ? resolve(window.MusicKit) : reject(new Error("MusicKit failed to load")));
      document.addEventListener("musickitloaded", done, { once: true });
      const script = document.createElement("script");
      script.src = SCRIPT_URL;
      script.async = true;
      script.dataset.webComponents = "";
      script.onerror = () => {
        loading = null;
        script.remove();
        reject(new Error("Couldn't load Apple Music (MusicKit)"));
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}

let instance: Promise<MusicKitInstance> | null = null;

/** Configure MusicKit once with a developer token from the server. */
export function getMusicKit(developerToken: () => Promise<string>): Promise<MusicKitInstance> {
  if (!instance) {
    instance = (async () => {
      const MusicKit = await loadMusicKit();
      return MusicKit.configure({
        developerToken: await developerToken(),
        app: { name: "Unnamed Music App", build: "0.1.0" },
      });
    })().catch((err) => {
      instance = null;
      throw err;
    });
  }
  return instance;
}

/** Queue one Apple Music song in MusicKit as an ExternalPlayback. */
export function createApplePlayback(
  music: MusicKitInstance,
  song: { catalogId?: string; libraryId?: string },
): ExternalPlayback {
  const states = window.MusicKit?.PlaybackStates ?? {};
  const listeners = new Set<(e: ExternalPlaybackEvent) => void>();
  const emit = (e: ExternalPlaybackEvent) => {
    for (const l of listeners) l(e);
  };
  let started = false;
  let stopped = false;

  const onTime = () => {
    if (!started || stopped) return;
    emit({ position: music.currentPlaybackTime, duration: music.currentPlaybackDuration });
  };
  const onState = (event: MusicKitEvent) => {
    if (!started || stopped || event.state === undefined) return;
    if (event.state === states.ended || event.state === states.completed) {
      emit({ playing: false, ended: true });
    } else if (event.state === states.playing) {
      emit({ playing: true });
    } else if (event.state === states.paused || event.state === states.stopped) {
      emit({ playing: false });
    }
  };

  function detach() {
    music.removeEventListener("playbackTimeDidChange", onTime);
    music.removeEventListener("playbackStateDidChange", onState);
  }

  return {
    async play() {
      if (stopped) return;
      if (!started) {
        started = true;
        music.addEventListener("playbackTimeDidChange", onTime);
        music.addEventListener("playbackStateDidChange", onState);
        // Queue lazily so a stale selection can't replace a newer one.
        await music.setQueue(song.catalogId ? { song: song.catalogId } : { songs: [song.libraryId] });
      }
      await music.play();
    },
    async pause() {
      await music.pause();
    },
    async seek(seconds) {
      await music.seekToTime(Math.max(0, seconds));
    },
    async setVolume(volume) {
      music.volume = Math.min(1, Math.max(0, volume));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      detach();
      if (started) await Promise.resolve(music.stop()).catch(() => undefined);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
