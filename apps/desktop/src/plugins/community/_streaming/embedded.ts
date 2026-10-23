import type { ExternalPlayback, ExternalPlaybackEvent } from "@/plugins/types";
import { openDock, type DockHandle, type DockOptions } from "./dock";

/**
 * Turns a service's official embedded player (YouTube IFrame, SoundCloud Widget) into an
 * `ExternalPlayback` for the host. The service-specific part is a small `Driver`; the state
 * machine here (open on demand, pending seek/volume, end-of-track once, close and reopen,
 * stop) is shared and tested once.
 */

export interface DriverHooks {
  /** The embedded player accepts commands. */
  ready: (info: { durationSec?: number }) => void;
  state: (state: "playing" | "paused" | "ended") => void;
  progress: (positionSec: number, durationSec?: number) => void;
  /** Something went wrong. `skip` means this item can never play here, so the host should move on. */
  failed: (message: string, skip: boolean) => void;
}

export interface DriverControls {
  play: () => void | Promise<void>;
  pause: () => void | Promise<void>;
  seek: (seconds: number) => void;
  /** 0..1 */
  setVolume: (volume: number) => void;
  destroy: () => void;
}

export interface Driver {
  setup: (body: HTMLElement, hooks: DriverHooks) => Promise<DriverControls>;
}

export interface EmbeddedSpec {
  dock: Omit<DockOptions, "onClose">;
  driver: Driver;
  /** Test seam. */
  open?: (opts: DockOptions) => DockHandle;
}

export type EmbeddedState = "idle" | "opening" | "ready" | "playing" | "paused" | "ended" | "closed" | "failed" | "stopped";

export interface EmbeddedPlayback extends ExternalPlayback {
  readonly state: EmbeddedState;
}

export function createEmbeddedPlayback(spec: EmbeddedSpec): EmbeddedPlayback {
  const open = spec.open ?? openDock;
  const listeners = new Set<(e: ExternalPlaybackEvent) => void>();
  const emit = (e: ExternalPlaybackEvent) => {
    for (const l of listeners) l(e);
  };

  let state: EmbeddedState = "idle";
  let dock: DockHandle | null = null;
  let controls: DriverControls | null = null;
  let opening: Promise<DriverControls> | null = null;
  let volume = 1;
  let position = 0;
  let pendingSeek = 0;
  let ended = false;

  const hooks: DriverHooks = {
    ready(info) {
      if (state === "stopped") return;
      if (info.durationSec && info.durationSec > 0) emit({ duration: info.durationSec });
    },
    state(s) {
      if (state === "stopped" || state === "closed") return;
      if (s === "playing") {
        state = "playing";
        emit({ playing: true });
      } else if (s === "paused") {
        state = "paused";
        emit({ playing: false });
      } else if (!ended) {
        ended = true;
        state = "ended";
        emit({ playing: false, ended: true });
      }
    },
    progress(pos, dur) {
      if (state === "stopped" || state === "closed") return;
      position = pos;
      emit(dur && dur > 0 ? { position: pos, duration: dur } : { position: pos });
    },
    failed(message, skip) {
      if (state === "stopped") return;
      dock?.setNote(message);
      emit({ playing: false });
      if (skip && !ended) {
        ended = true;
        state = "failed";
        emit({ ended: true });
      }
    },
  };

  function onUserClose() {
    // The person closed the panel: the player goes with it, and playback stops.
    controls?.destroy();
    controls = null;
    opening = null;
    dock = null;
    if (state !== "stopped") {
      state = "closed";
      emit({ playing: false });
    }
  }

  function ensure(): Promise<DriverControls> {
    if (controls) return Promise.resolve(controls);
    if (opening) return opening;
    state = "opening";
    ended = false;
    dock = open({ ...spec.dock, onClose: onUserClose });
    const mine = dock;
    const job = spec.driver
      .setup(mine.body, hooks)
      .then((c) => {
        if (state === "stopped" || dock !== mine) {
          c.destroy();
          throw new Error("closed");
        }
        controls = c;
        state = "ready";
        c.setVolume(volume);
        if (pendingSeek > 0) {
          c.seek(pendingSeek);
          pendingSeek = 0;
        }
        return c;
      })
      .catch((err) => {
        opening = null;
        if (state !== "stopped" && dock === mine) {
          state = "failed";
          mine.setNote(err instanceof Error && err.message !== "closed" ? err.message : "The player could not be started.");
        }
        throw err;
      });
    opening = job;
    return job;
  }

  return {
    get state() {
      return state;
    },
    async play() {
      if (state === "stopped") return;
      if (state === "closed") pendingSeek = position;
      const c = await ensure();
      await c.play();
    },
    async pause() {
      if (state === "stopped") return;
      await controls?.pause();
    },
    async seek(seconds) {
      if (state === "stopped") return;
      const s = Math.max(0, seconds);
      position = s;
      if (controls) controls.seek(s);
      else pendingSeek = s;
    },
    async setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      controls?.setVolume(volume);
    },
    async stop() {
      if (state === "stopped") return;
      state = "stopped";
      listeners.clear();
      controls?.destroy();
      controls = null;
      opening = null;
      dock?.close();
      dock = null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
