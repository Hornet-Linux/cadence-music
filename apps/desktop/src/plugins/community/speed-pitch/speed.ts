export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

export interface SpeedPreset {
  id: string;
  label: string;
  rate: number;
  /** True keeps the pitch; false lets pitch follow speed (tape / nightcore style). */
  preservePitch: boolean;
  hint: string;
}

export const SPEED_PRESETS: SpeedPreset[] = [
  { id: "normal", label: "Normal", rate: 1, preservePitch: true, hint: "Original speed and pitch" },
  { id: "slowed", label: "Slowed", rate: 0.85, preservePitch: false, hint: "Slower and lower, like a slowed edit" },
  { id: "nightcore", label: "Nightcore", rate: 1.25, preservePitch: false, hint: "Faster and higher" },
  { id: "half", label: "Half speed", rate: 0.5, preservePitch: true, hint: "Same pitch, great for learning a part" },
  { id: "brisk", label: "Brisk", rate: 1.5, preservePitch: true, hint: "Same pitch, quicker" },
];

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) * 20) / 20;
}

export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}x`;
}

/** Which preset the current values equal, if any. */
export function matchSpeedPreset(rate: number, preservePitch: boolean): string | null {
  return SPEED_PRESETS.find((p) => p.rate === rate && p.preservePitch === preservePitch)?.id ?? null;
}

/** Semitones the pitch moves when it follows the speed. */
export function pitchShiftSemitones(rate: number): number {
  return 12 * Math.log2(rate);
}

export function describePitch(rate: number, preservePitch: boolean): string {
  if (preservePitch || rate === 1) return "Pitch stays the same";
  const st = pitchShiftSemitones(rate);
  const v = Math.round(st * 10) / 10;
  return `Pitch ${v > 0 ? "up" : "down"} ${Math.abs(v)} semitones`;
}

/** The next/previous step on a 0.05 grid, for the speed up / slow down commands. */
export function stepRate(rate: number, direction: 1 | -1): number {
  const step = rate >= 1 ? 0.1 : 0.05;
  return clampRate(rate + direction * step);
}
