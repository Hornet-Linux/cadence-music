import { create } from "zustand";
import { usePlayer } from "@/player/playerStore";
import { useTuning, type Tuning } from "@/player/tuning";
import type { PluginContext } from "@/plugins/types";
import { clampBpm, clampRate, countInPlan, isActive, loopJump, nudge, noLoop, setA, setB, type Loop } from "./loop";

interface PracticeState {
  loop: Loop;
  rate: number;
  bpm: number;
  beats: number;
  /** Count in again every time the loop repeats. */
  countInEachLoop: boolean;
  /** A count-in is sounding right now. */
  countingIn: boolean;
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

type PlayerApi = PluginContext["player"];

/** How often the loop is checked. The player refreshes its position at 100 ms while a loop is held. */
const POLL_MS = 50;
/** Jump this much before B so a check that arrives late still lands before B, not after it. */
const LOOKAHEAD_SEC = 0.15;
/** Vendor players report their position about once a second. */
const EXTERNAL_LOOKAHEAD_SEC = 0.8;
/** If the person has moved further than this past B, they meant to leave the loop. */
const PAST_B_SEC = 2.5;

let player: PlayerApi | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let stopNowPlaying: (() => void) | null = null;
let stopSyncing: (() => void) | null = null;
let lastTrackId: string | null = null;
let audioCtx: AudioContext | null = null;
/** The player settings as they were before this plugin changed them (null while it has not touched them). */
let saved: Pick<Tuning, "rate" | "preservePitch"> | null = null;
/** The speed this plugin last asked the player for. */
let applied = 1;

/** Connect the engine to the plugin (`player.read` and `player.control`). */
export function attach(ctx: Pick<PluginContext, "player" | "onNowPlaying">): void {
  player = ctx.player;
  stopNowPlaying?.();
  stopNowPlaying = ctx.onNowPlaying((track) => onTrackChanged(track?.id ?? null));
}

/** Slow-down goes through the player's supported tuning settings; the player applies them to every deck. */
function applyRate(rate: number): void {
  const tuning = useTuning.getState();
  if (rate === 1) return releaseRate();
  if (!saved) saved = { rate: tuning.rate, preservePitch: tuning.preservePitch };
  applied = rate;
  tuning.set({ rate, preservePitch: true });
}

/** Give the speed back (to what it was before, unless someone else has changed it since). */
function releaseRate(): void {
  if (!saved) return;
  const tuning = useTuning.getState();
  if (tuning.rate === applied) tuning.set({ rate: saved.rate, preservePitch: saved.preservePitch });
  saved = null;
}

/** While a loop is active the player must not move on to the next song (crossfade, gapless). */
function syncHold(): void {
  const s = player?.getState();
  const { loop } = usePractice.getState();
  const hold = !!s && s.current !== null && usePlayer.getState().engine !== "external" && isActive(loop) && s.position < loop.b + PAST_B_SEC;
  if (useTuning.getState().holdTrack !== hold) useTuning.getState().set({ holdTrack: hold });
}

function onTrackChanged(id: string | null): void {
  if (id === lastTrackId) return;
  // A different song: its loop points and the slow-down belong to the old one.
  lastTrackId = id;
  releaseRate();
  usePractice.setState({ loop: noLoop, rate: 1 });
  syncHold();
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

    markA: () => set((s) => ({ loop: setA(s.loop, snap()?.position ?? 0, duration()) })),
    markB: () => set((s) => ({ loop: setB(s.loop, snap()?.position ?? 0, duration()) })),
    nudgePoint: (point, delta) => set((s) => ({ loop: nudge(s.loop, point, delta, duration()) })),
    toggleLoop: () => set((s) => ({ loop: s.loop.a !== null && s.loop.b !== null ? { ...s.loop, enabled: !s.loop.enabled } : s.loop })),
    clearLoop: () => set({ loop: noLoop }),

    setRate(rate) {
      const next = clampRate(rate);
      set({ rate: next });
      applyRate(next);
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
  onTrackChanged(s.current?.id ?? null);
  syncHold();
  if (!s.isPlaying || store.countingIn) return;
  const external = usePlayer.getState().engine === "external";
  const jump = loopJump(s.position, store.loop, external ? EXTERNAL_LOOKAHEAD_SEC : LOOKAHEAD_SEC);
  if (jump === null) return;
  if (store.countInEachLoop) void store.countInAndPlay(jump);
  else player.seek(jump);
}

/** Start watching the player: enforces the loop. */
export function startEngine(): void {
  if (timer) return;
  lastTrackId = snap()?.current?.id ?? null;
  // Changing the loop takes effect at once; the poll below only has to catch the playhead reaching B.
  stopSyncing = usePractice.subscribe((s, prev) => {
    if (s.loop !== prev.loop) syncHold();
  });
  timer = setInterval(tick, POLL_MS);
}

/** Stop looping and give the speed and the track back to the player. */
export function stopEngine(): void {
  if (timer) clearInterval(timer);
  timer = null;
  stopSyncing?.();
  stopSyncing = null;
  stopNowPlaying?.();
  stopNowPlaying = null;
  releaseRate();
  useTuning.getState().set({ holdTrack: false });
  usePractice.setState({ loop: noLoop, rate: 1, countingIn: false });
  player = null;
  lastTrackId = null;
}