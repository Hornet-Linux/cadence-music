/**
 * The maths behind following a host: where the host should be right now, how far off we are, and
 * the smallest correction that fixes it. Pure functions, so they are easy to test.
 */

export interface HostSnapshot {
  trackId: string | null;
  playing: boolean;
  /** Seconds into the track at `updatedAt`. */
  position: number;
  /** Server clock (epoch ms) when `position` was true. */
  updatedAt: number;
  seq: number;
  durationSec?: number;
}

/** Where the host is now, given the server's current time. */
export function expectedPosition(host: HostSnapshot, serverNow: number): number {
  const elapsed = host.playing ? Math.max(0, serverNow - host.updatedAt) / 1000 : 0;
  const position = host.position + elapsed;
  return host.durationSec && host.durationSec > 0 ? Math.min(position, host.durationSec) : position;
}

export interface ClockSample {
  /** Local time when the request was sent and when the answer arrived (epoch ms). */
  sent: number;
  received: number;
  /** The server's clock in the answer. */
  serverNow: number;
}

/**
 * How far the server's clock is ahead of ours (add it to local time to get server time).
 * Uses the sample with the shortest round trip, which has the least timing error.
 */
export function clockOffset(samples: ClockSample[]): number {
  if (samples.length === 0) return 0;
  const best = samples.reduce((a, b) => (b.received - b.sent < a.received - a.sent ? b : a));
  return best.serverNow - (best.sent + best.received) / 2;
}

export const DRIFT = {
  /** Within this many seconds we leave playback alone. */
  ignore: 0.15,
  /** Past this we jump to the right spot (when speed adjustment is available). */
  seek: 2,
  /** Past this we jump, when we cannot adjust speed. */
  seekWithoutRate: 0.8,
  /** Speed is nudged by at most this fraction. */
  maxRateChange: 0.05,
  /** Jumps closer together than this are held back, to give a seek time to settle. */
  seekCooldownMs: 4000,
} as const;

export type DriftFix = { kind: "none"; rate: 1 } | { kind: "rate"; rate: number } | { kind: "seek"; rate: 1 };

/**
 * Decide how to correct `drift` (our position minus where we should be; positive means ahead).
 * Small drift is absorbed by a slight speed change, large drift by a jump.
 */
export function correctDrift(drift: number, options: { canAdjustRate: boolean; sinceLastSeekMs: number }): DriftFix {
  const size = Math.abs(drift);
  if (size <= DRIFT.ignore) return { kind: "none", rate: 1 };
  const jumpAt = options.canAdjustRate ? DRIFT.seek : DRIFT.seekWithoutRate;
  const clamp = (n: number) => Math.min(DRIFT.maxRateChange, Math.max(-DRIFT.maxRateChange, n));
  if (size > jumpAt) {
    if (options.sinceLastSeekMs >= DRIFT.seekCooldownMs) return { kind: "seek", rate: 1 };
    return options.canAdjustRate ? { kind: "rate", rate: 1 - clamp(drift / 4) } : { kind: "none", rate: 1 };
  }
  if (!options.canAdjustRate) return { kind: "none", rate: 1 };
  // Ahead (positive drift) means play a little slower, behind means a little faster.
  return { kind: "rate", rate: Math.round((1 - clamp(drift / 4)) * 1000) / 1000 };
}

export type FollowStep = { type: "load" } | { type: "play" } | { type: "pause" } | { type: "seek"; to: number };

/**
 * What to do when the host's state changes (a new track, play, pause or a jump). Ordinary
 * once-a-second drift correction is separate (see correctDrift).
 */
export function reconcile(
  host: HostSnapshot,
  expected: number,
  local: { currentId: string | null; isPlaying: boolean; position: number },
): FollowStep[] {
  if (!host.trackId) return local.isPlaying ? [{ type: "pause" }] : [];
  if (local.currentId !== host.trackId) return [{ type: "load" }];
  const steps: FollowStep[] = [];
  const off = Math.abs(local.position - expected);
  if (off > (host.playing ? 1 : 0.5)) steps.push({ type: "seek", to: expected });
  if (host.playing && !local.isPlaying) steps.push({ type: "play" });
  if (!host.playing && local.isPlaying) steps.push({ type: "pause" });
  return steps;
}

/** How far out of step we are, for display: "in sync", "0.4 s behind", "3 s ahead". */
export function describeDrift(drift: number): string {
  const size = Math.abs(drift);
  if (size <= 0.3) return "In sync";
  const text = size < 10 ? size.toFixed(1) : Math.round(size).toString();
  return `${text} s ${drift > 0 ? "ahead" : "behind"}`;
}