import { create } from "zustand";
import type { PlayerApi } from "@/plugins/types";
import { getMediaElement, setPlaybackRate, watchMediaElement } from "../_social/mediaElement";
import { clampBpm, clampRate, countInPlan, isActive, isExternalSource, loopJump, nudge, noLoop, setA, setB, type Loop } from "./loop";

interface PracticeState {
  loop: Loop;
  rate: number;
  bpm: number;
  beats: number;
  /** Count in again every time the loop repeats. */
  countInEachLoop: boolean;
  /** A count-in is sounding right now. */
  countingIn: boolean;
  /** Speed changes need a plain audio element, which we only learn about once the player has played or sought. */
  rateAvailable: boolean;
  markA: () => void;
  markB: () => void;
  nudgePoint: (point: "a" | "b", delta: number) => void;
  toggleLoop: () => void;
  clearLoop: () => void;
  setRate: (rate: number) => void;
  setBpm: (bpm: number) => void;
  setBeats: (beats: number) => void;
  setCountInEachLoop: (on: boolean) => void;
  /** Count in, then play from `from` (default: A, or where the playhead is). */
  countInAndPlay: (from?: number) => Promise<void>;
}

let player: PlayerApi | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let stopWatching: (() => void) | null = null;
let lastTrackId: string | null = null;
let audioCtx: AudioContext | null = null;

export function attach(api: PlayerApi): void {
  player = api;
}

const snap = () => player?.getState();

/** Sound the clicks of a count-in on the Web Audio clock. */
export function playClicks(bpm: number, beats: number): Promise<void> {
  const plan = countInPlan(bpm, beats);
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return new Promise((done) => setTimeout(done, plan.total * 1000));
  audioCtx = audioCtx ?? new Ctor();
  const ctx = audioCtx;
  void ctx.resume();
  const start = ctx.currentTime + 0.05;
  plan.clicks.forEach((at, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = i === 0 ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(0.35, start + at + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.07);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + at);
    osc.stop(start + at + 0.09);
  });
  return new Promise((done) => setTimeout(done, (plan.total + 0.05) * 1000));
}

export const usePractice = create<PracticeState>((set, get) => {
  const duration = () => snap()?.duration ?? 0;

  return {
    loop: noLoop,
    rate: 1,
    bpm: 100,
    beats: 4,
    countInEachLoop: false,
    countingIn: false,
    rateAvailable: false,

    markA: () => set((s) => ({ loop: setA(s.loop, snap()?.position ?? 0, duration()) })),
    markB: () => set((s) => ({ loop: setB(s.loop, snap()?.position ?? 0, duration()) })),
    nudgePoint: (point, delta) => set((s) => ({ loop: nudge(s.loop, point, delta, duration()) })),
    toggleLoop: () => set((s) => ({ loop: s.loop.a !== null && s.loop.b !== null ? { ...s.loop, enabled: !s.loop.enabled } : s.loop })),
    clearLoop: () => set({ loop: noLoop }),

    setRate(rate) {
      const next = clampRate(rate);
      set({ rate: next });
      const current = snap()?.current;
      if (!current || isExternalSource(current.source)) return;
      // Seeking in place tells us which <audio> element the player uses.
      if (!getMediaElement() && player) player.seek(snap()?.position ?? 0);
      set({ rateAvailable: setPlaybackRate(next) });
    },
    setBpm: (bpm) => set({ bpm: clampBpm(bpm) }),
    setBeats: (beats) => set({ beats: Math.min(8, Math.max(1, Math.round(beats))) }),
    setCountInEachLoop: (countInEachLoop) => set({ countInEachLoop }),

    async countInAndPlay(from) {
      if (!player || get().countingIn) return;
      const state = player.getState();
      if (!state.current) return;
      const loop = get().loop;
      const target = from ?? (isActive(loop) ? loop.a : state.position);
      set({ countingIn: true });
      try {
        if (state.isPlaying) player.toggle();
        player.seek(target);
        await playClicks(get().bpm, get().beats);
        if (!player.getState().isPlaying) player.toggle();
      } finally {
        set({ countingIn: false });
      }
    },
  };
});

function tick() {
  const s = snap();
  if (!player || !s) return;
  const store = usePractice.getState();
  const id = s.current?.id ?? null;
  if (id !== lastTrackId) {
    // A different song: its loop points don't apply any more. The speed setting stays.
    lastTrackId = id;
    usePractice.setState({ loop: noLoop });
    if (store.rate !== 1) setPlaybackRate(store.rate);
  }
  const external = isExternalSource(s.current?.source);
  if (!external && store.rate !== 1) {
    const el = getMediaElement();
    if (el && Math.abs(el.playbackRate - store.rate) > 0.001) setPlaybackRate(store.rate);
  }
  if (!s.isPlaying || store.countingIn) return;
  const jump = loopJump(s.position, store.loop, external ? 0.8 : 0.08);
  if (jump === null) return;
  if (store.countInEachLoop) void store.countInAndPlay(jump);
  else player.seek(jump);
}

/** Start watching the player: enforces the loop and keeps the speed. */
export function startEngine(): void {
  if (timer) return;
  stopWatching = watchMediaElement();
  lastTrackId = snap()?.current?.id ?? null;
  timer = setInterval(tick, 100);
}

export function stopEngine(): void {
  if (timer) clearInterval(timer);
  timer = null;
  stopWatching?.();
  stopWatching = null;
  setPlaybackRate(1);
  usePractice.setState({ loop: noLoop, rate: 1, countingIn: false, rateAvailable: false });
}