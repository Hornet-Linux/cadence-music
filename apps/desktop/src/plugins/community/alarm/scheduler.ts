import type { PlayerApi } from "@/plugins/types";
import type { Track } from "@/shared/types";
import { useTuning } from "@/player/tuning";
import { checkAlarm, rampGain, type Alarm } from "./alarm";

/** Watches the clock and tells the plugin when an alarm is due. Works only while the page is running. */
export class AlarmScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopListening: (() => void) | null = null;

  constructor(
    private readonly deps: {
      now: () => Date;
      alarms: () => Alarm[];
      update: (id: string, patch: Partial<Alarm>) => void;
      ring: (alarm: Alarm, at: number) => void;
      missed: (alarm: Alarm, at: number) => void;
    },
  ) {}

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), 5000);
    // A phone that slept wakes up with the page; check right away rather than in 5 s.
    const wake = () => this.check();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
    if (typeof window !== "undefined") window.addEventListener("focus", wake);
    this.stopListening = () => {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
      if (typeof window !== "undefined") window.removeEventListener("focus", wake);
    };
    this.check();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopListening?.();
    this.stopListening = null;
  }

  check() {
    const now = this.deps.now();
    for (const alarm of this.deps.alarms()) {
      const due = checkAlarm(alarm, now);
      if (due.kind === "none") continue;
      // One-time alarms switch themselves off once handled.
      this.deps.update(alarm.id, { handledAt: due.at, ...(alarm.days.length === 0 ? { enabled: false } : {}) });
      if (due.kind === "ring") this.deps.ring(alarm, due.at);
      else this.deps.missed(alarm, due.at);
    }
  }
}

export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface RingDeps {
  player: Pick<PlayerApi, "playTracks" | "getState">;
  tracksFor: (alarm: Alarm) => Track[];
  /**
   * Music to play when the chosen source is empty (no liked songs yet, a deleted playlist).
   * A wake-up alarm that stays silent is the worst outcome, so anything playable beats nothing.
   */
  fallback?: () => Track[];
  random?: () => number;
  /** How long to wait before checking that playback really started. */
  verifyAfterMs?: number;
}

export type RingResult = { ok: true; started: number; usedFallback?: boolean } | { ok: false; reason: "empty" | "blocked" | "error" };

/**
 * Start the alarm's music, bringing the volume up gently. Resolves once playback is confirmed
 * (or has clearly failed: browsers may refuse to start audio without a recent interaction).
 */
export async function ringAlarm(alarm: Alarm, deps: RingDeps): Promise<RingResult> {
  let tracks = deps.tracksFor(alarm);
  let usedFallback = false;
  if (tracks.length === 0) {
    tracks = deps.fallback?.() ?? [];
    usedFallback = tracks.length > 0;
  }
  if (tracks.length === 0) return { ok: false, reason: "empty" };
  const queue = alarm.shuffle ? shuffled(tracks, deps.random) : tracks;
  const tuning = useTuning.getState();
  if (alarm.rampSec > 0) tuning.set({ masterGain: rampGain(0, alarm.rampSec) });
  try {
    await deps.player.playTracks(queue, 0);
  } catch {
    tuning.set({ masterGain: 1 });
    return { ok: false, reason: "error" };
  }
  await new Promise((resolve) => setTimeout(resolve, deps.verifyAfterMs ?? 3000));
  if (!deps.player.getState().isPlaying) {
    tuning.set({ masterGain: 1 });
    return { ok: false, reason: "blocked" };
  }
  if (alarm.rampSec > 0) await ramp(alarm.rampSec);
  return usedFallback ? { ok: true, started: queue.length, usedFallback } : { ok: true, started: queue.length };
}

/** Raise the master gain from near-silent to full over `rampSec` seconds. */
export function ramp(rampSec: number, stepMs = 500): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const id = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      useTuning.getState().set({ masterGain: rampGain(elapsed, rampSec) });
      if (elapsed >= rampSec) {
        clearInterval(id);
        resolve();
      }
    }, stepMs);
  });
}
