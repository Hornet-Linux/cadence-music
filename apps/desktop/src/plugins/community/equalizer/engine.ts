import type { AudioEffect } from "@/plugins/types";
import { createPrefs } from "../_audio-kit/prefs";
import { BAND_COUNT, BAND_FREQS, BAND_Q, DEFAULT_EQ, bandType, dbToGain, sanitizeSettings, type EqSettings } from "./eq";

export const eqPrefs = createPrefs<EqSettings>("settings", DEFAULT_EQ, sanitizeSettings);

interface Live {
  ctx: AudioContext;
  preamp: GainNode;
  filters: BiquadFilterNode[];
}
let live: Live | null = null;

/** Push the current settings into the running filters (no rebuild, no clicks). */
export function applyLive() {
  if (!live) return;
  const s = eqPrefs.get();
  const t = live.ctx.currentTime;
  live.preamp.gain.setTargetAtTime(s.on ? dbToGain(s.preamp) : 1, t, 0.02);
  live.filters.forEach((f, i) => f.gain.setTargetAtTime(s.on ? (s.gains[i] ?? 0) : 0, t, 0.02));
}

eqPrefs.use.subscribe(applyLive);

/** preamp -> 10 band filters (low shelf, 8 peaking, high shelf) in series. */
export const eqEffect: AudioEffect = {
  id: "cadence.equalizer",
  label: "Equalizer",
  order: 10,
  create(ctx) {
    const s = eqPrefs.get();
    const preamp = ctx.createGain();
    preamp.gain.value = s.on ? dbToGain(s.preamp) : 1;
    const filters: BiquadFilterNode[] = [];
    let tail: AudioNode = preamp;
    for (let i = 0; i < BAND_COUNT; i++) {
      const f = ctx.createBiquadFilter();
      f.type = bandType(i);
      f.frequency.value = BAND_FREQS[i];
      f.Q.value = BAND_Q;
      f.gain.value = s.on ? (s.gains[i] ?? 0) : 0;
      tail.connect(f);
      tail = f;
      filters.push(f);
    }
    const mine: Live = { ctx, preamp, filters };
    live = mine;
    return {
      input: preamp,
      output: tail,
      dispose() {
        if (live === mine) live = null;
      },
    };
  },
};
