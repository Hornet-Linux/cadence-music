import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSamples, compatibleCamelot, estimateEnergy, estimateKey, estimateTempo, SAMPLE_RATE } from "./dsp.js";

/** A simple drum pattern: kick on every beat, hi-hat on the off-beats. */
function drums(bpm: number, seconds: number, loud = 0.8): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const beat = (60 / bpm) * SAMPLE_RATE;
  for (let b = 0; b * beat < out.length; b++) {
    const start = Math.round(b * beat);
    for (let i = 0; i < 2200 && start + i < out.length; i++) {
      out[start + i]! += loud * Math.exp(-i / 500) * Math.sin(2 * Math.PI * (70 + 90 * Math.exp(-i / 300)) * (i / SAMPLE_RATE));
    }
    const hat = start + Math.round(beat / 2);
    let seed = b * 7919 + 13;
    for (let i = 0; i < 600 && hat + i < out.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[hat + i]! += 0.25 * loud * Math.exp(-i / 120) * (seed / 0x7fffffff - 0.5);
    }
  }
  return out;
}

const freq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Chords with a few harmonics, one chord per `seconds / chords.length`. */
function progression(chords: number[][], seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const per = out.length / chords.length;
  for (let i = 0; i < out.length; i++) {
    const notes = chords[Math.min(chords.length - 1, Math.floor(i / per))]!;
    let v = 0;
    for (const n of notes) for (let h = 1; h <= 4; h++) v += Math.sin((2 * Math.PI * freq(n) * h * i) / SAMPLE_RATE) / h;
    out[i] = (0.4 * v) / notes.length;
  }
  return out;
}

for (const bpm of [75, 90, 100, 120, 128, 140, 174]) {
  test(`estimates ${bpm} BPM from a drum pattern`, () => {
    const t = estimateTempo(drums(bpm, 45));
    assert.ok(t, "a tempo is found");
    assert.ok(Math.abs(t.bpm - bpm) <= 1.5, `${bpm} -> ${t.bpm}`);
    assert.ok(t.confidence > 0.2, `confidence ${t.confidence}`);
  });
}

test("a slow pattern with busy hi-hats may be read at double speed, never at an unrelated tempo", () => {
  const t = estimateTempo(drums(70, 45))!;
  assert.ok(Math.abs(t.bpm - 70) <= 1.5 || Math.abs(t.bpm - 140) <= 3, `70 -> ${t.bpm}`);
});

test("a steady tone has no clear tempo or a low-confidence one", () => {
  const tone = new Float32Array(SAMPLE_RATE * 30).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
  const t = estimateTempo(tone);
  assert.ok(t === null || t.confidence < 0.15, JSON.stringify(t));
});

test("too-short clips give no tempo", () => {
  assert.equal(estimateTempo(new Float32Array(SAMPLE_RATE * 3)), null);
});

test("finds major and minor keys from chord progressions", () => {
  const C = [48, 52, 55];
  const F = [53, 57, 60];
  const G = [55, 59, 62];
  const cMajor = estimateKey(progression([C, F, G, C], 30))!;
  assert.equal(cMajor.key, "C major");
  assert.equal(cMajor.camelot, "8B");
  const Am = [57, 60, 64];
  const Dm = [50, 53, 57];
  const E = [52, 56, 59];
  const aMinor = estimateKey(progression([Am, Dm, E, Am], 30))!;
  assert.equal(aMinor.key, "A minor");
  assert.equal(aMinor.camelot, "8A");
  // Transposed up a whole tone: D major (I IV V I).
  const D = [50, 54, 57];
  const G2 = [55, 59, 62];
  const A = [57, 61, 64];
  assert.equal(estimateKey(progression([D, G2, A, D], 30))!.key, "D major");
});

test("silence has no key", () => {
  assert.equal(estimateKey(new Float32Array(SAMPLE_RATE * 10)), null);
});

test("energy rises with loudness and activity", () => {
  const quietSlow = new Float32Array(drums(70, 20, 0.05));
  const loudFast = drums(170, 20, 0.9);
  const a = estimateEnergy(quietSlow);
  const b = estimateEnergy(loudFast);
  assert.ok(b > a + 0.2, `${a} vs ${b}`);
  assert.ok(a >= 0 && b <= 1);
});

test("analyzeSamples bundles the estimates", () => {
  const f = analyzeSamples(drums(100, 40));
  assert.ok(f.bpm !== null && Math.abs(f.bpm - 100) <= 1.5);
  assert.ok(f.energy > 0);
});

test("compatible camelot codes wrap around the wheel", () => {
  assert.deepEqual(compatibleCamelot("8A"), ["8A", "9A", "7A", "8B"]);
  assert.deepEqual(compatibleCamelot("12B"), ["12B", "1B", "11B", "12A"]);
  assert.deepEqual(compatibleCamelot("1A"), ["1A", "2A", "12A", "1B"]);
  assert.deepEqual(compatibleCamelot("nope"), []);
});