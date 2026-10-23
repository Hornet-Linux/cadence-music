import { create } from "zustand";
import type { PlayerApi } from "@/plugins/types";
import { useTuning } from "@/player/tuning";

export type SleepKind = "minutes" | "track";

export interface SleepActive {
  kind: SleepKind;
  /** Wall-clock time (ms) the timer ends, for "minutes". */
  endsAt: number | null;
  minutes: number | null;
}

export const useSleep = create<{ active: SleepActive | null }>(() => ({ active: null }));

/** Volume multiplier while fading out: 1 until `fadeSec` before the end, then eases to 0. */
export function fadeGain(remainingSec: number, fadeSec: number): number {
  if (!(fadeSec > 0) || remainingSec >= fadeSec) return 1;
  const t = Math.max(0, remainingSec) / fadeSec;
  return Math.sin((t * Math.PI) / 2);
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

type PlayerHandle = Pick<PlayerApi, "getState" | "toggle">;

interface Deps {
  player: () => PlayerHandle;
  now?: () => number;
  /** Seconds of fade-out. */
  fadeSec: () => number;
}

/**
 * Counts down and fades the volume out. Two modes:
 *  - minutes: pause at a set time.
 *  - track:   let the current track finish, then stop (the player's "stop after track" flag does
 *             the stopping; this only fades the last seconds).
 * It fades through the player's master gain, so the user's own volume setting is untouched.
 */
export class SleepController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  /** True while we hold the player's stop-after-track flag. */
  private holdsStopFlag = false;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get running() {
    return this.timer !== null;
  }

  startMinutes(minutes: number) {
    const m = Math.min(24 * 60, Math.max(1, Math.round(minutes)));
    this.begin({ kind: "minutes", endsAt: this.now() + m * 60_000, minutes: m }, false);
  }

  startEndOfTrack() {
    this.begin({ kind: "track", endsAt: null, minutes: null }, true);
  }

  cancel() {
    this.stop();
    this.restoreGain();
    useSleep.setState({ active: null });
  }

  /** One step: exposed for tests; the interval calls it. */
  tick() {
    const active = useSleep.getState().active;
    if (!active) return this.stop();
    const fadeSec = this.deps.fadeSec();

    if (active.kind === "minutes" && active.endsAt !== null) {
      const remaining = (active.endsAt - this.now()) / 1000;
      if (remaining <= 0) return this.finish(true);
      useTuning.getState().set({ masterGain: fadeGain(remaining, fadeSec) });
      return;
    }

    // End of track.
    if (!useTuning.getState().stopAfterTrack) {
      // The player honoured the request (the track ended and playback stopped).
      this.holdsStopFlag = false;
      return this.finish(false);
    }
    const p = this.deps.player().getState();
    if (p.isPlaying && p.duration > 0) {
      const rate = useTuning.getState().rate || 1;
      useTuning.getState().set({ masterGain: fadeGain((p.duration - p.position) / rate, fadeSec) });
    }
  }

  private begin(active: SleepActive, stopAfterTrack: boolean) {
    this.stop();
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    if (stopAfterTrack) {
      useTuning.getState().set({ stopAfterTrack: true });
      this.holdsStopFlag = true;
    }
    useSleep.setState({ active });
    this.timer = setInterval(() => this.tick(), 250);
    this.tick();
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.releaseStopFlag();
  }

  private releaseStopFlag() {
    if (this.holdsStopFlag) useTuning.getState().set({ stopAfterTrack: false });
    this.holdsStopFlag = false;
  }

  private restoreGain() {
    useTuning.getState().set({ masterGain: 1 });
  }

  /** Time is up: pause (minutes mode), bring the volume back for next time, clear the timer. */
  private finish(pause: boolean) {
    this.stop();
    useSleep.setState({ active: null });
    if (pause && this.deps.player().getState().isPlaying) this.deps.player().toggle();
    // Restore after the pause has taken hold, so the music does not blip back at full volume.
    this.restoreTimer = setTimeout(() => this.restoreGain(), pause ? 600 : 0);
  }
}
