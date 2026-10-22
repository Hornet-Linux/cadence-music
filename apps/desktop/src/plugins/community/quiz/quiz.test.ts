import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { buildQuiz, DIFFICULTIES, emptyScore, isQuizzable, optionLabel, pickStart, pointsFor, quizProblem, recordAnswer, shuffle, uniqueSongs, verdict } from "./quiz";

const song = (n: number, artist = `Artist ${n}`, album = `Album ${n}`, extra: Partial<Track> = {}): Track => ({
  id: `server:${n}`,
  title: `Song ${n}`,
  artists: [{ id: artist, name: artist }],
  album,
  durationSec: 200,
  source: "server",
  ...extra,
});
const library = Array.from({ length: 12 }, (_, i) => song(i + 1));

/** A small deterministic random source. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("choosing songs", () => {
  it("only quizzes songs that can play a snippet", () => {
    expect(isQuizzable(song(1))).toBe(true);
    expect(isQuizzable(song(1, "A", "B", { source: "spotify" }))).toBe(false);
    expect(isQuizzable(song(1, "A", "B", { artists: [] }))).toBe(false);
    expect(isQuizzable({ ...song(1), title: "  " })).toBe(false);
  });
  it("counts the same song once even if it is stored twice", () => {
    const dupes = [song(1), { ...song(1), id: "server:99", title: "Song 1 (Remastered)" }, song(2)];
    expect(uniqueSongs(dupes)).toHaveLength(2);
  });
  it("explains why a small library cannot make a quiz", () => {
    expect(quizProblem([])).toMatch(/server or local files/);
    expect(quizProblem(library.slice(0, 3))).toMatch(/at least 4/);
    expect(quizProblem(library)).toBeNull();
  });
});

describe("buildQuiz", () => {
  const quiz = buildQuiz(library, { count: 8, difficulty: "medium", rng: seeded(7) });

  it("makes the requested number of questions, each with four distinct options including the answer", () => {
    expect(quiz).toHaveLength(8);
    for (const q of quiz) {
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options.map(optionLabel)).size).toBe(4);
      expect(q.options[q.correctIndex].id).toBe(q.track.id);
    }
  });
  it("never asks about the same song twice", () => {
    expect(new Set(quiz.map((q) => q.track.id)).size).toBe(quiz.length);
  });
  it("is repeatable with the same random source and varies with another", () => {
    const again = buildQuiz(library, { count: 8, difficulty: "medium", rng: seeded(7) });
    expect(again.map((q) => q.track.id)).toEqual(quiz.map((q) => q.track.id));
    const other = buildQuiz(library, { count: 8, difficulty: "medium", rng: seeded(99) });
    expect(other.map((q) => q.track.id)).not.toEqual(quiz.map((q) => q.track.id));
  });
  it("asks for no more questions than there are songs", () => {
    expect(buildQuiz(library.slice(0, 5), { count: 20, difficulty: "easy", rng: seeded() })).toHaveLength(5);
    expect(buildQuiz(library.slice(0, 3), { count: 5, difficulty: "easy" })).toEqual([]);
  });
  it("on hard, fills options with songs by the same artist when it can", () => {
    const sameArtist = [
      ...Array.from({ length: 5 }, (_, i) => song(i + 1, "Same Band", "Same Album")),
      ...Array.from({ length: 6 }, (_, i) => song(i + 20)),
    ];
    const hard = buildQuiz(sameArtist, { count: 11, difficulty: "hard", rng: seeded(3) });
    const q = hard.find((x) => x.track.artists[0].name === "Same Band")!;
    const alike = q.options.filter((o) => o.id !== q.track.id && o.artists[0].name === "Same Band");
    expect(alike.length).toBeGreaterThanOrEqual(1);
    expect(alike.length).toBeLessThanOrEqual(2);
  });
  it("never offers a wrong option with the same title as the answer", () => {
    const covers = [song(1), { ...song(2), title: "Song 1", artists: [{ id: "x", name: "Cover Band" }] }, ...library.slice(2)];
    for (const q of buildQuiz(covers, { count: 12, difficulty: "easy", rng: seeded(5) })) {
      const titles = q.options.map((o) => o.title.toLowerCase());
      expect(new Set(titles).size).toBe(4);
    }
  });
});

describe("snippets", () => {
  it("starts inside the song, leaving room for the whole snippet", () => {
    for (const r of [0, 0.5, 0.999]) {
      const start = pickStart(200, 8, () => r);
      expect(start).toBeGreaterThanOrEqual(20);
      expect(start + 8).toBeLessThanOrEqual(200 * 0.75 + 1);
    }
  });
  it("starts at zero when the song is short or its length unknown", () => {
    expect(pickStart(10, 8, () => 0.5)).toBe(0);
    expect(pickStart(undefined, 8, () => 0.5)).toBe(0);
  });
  it("gets shorter and harder with difficulty", () => {
    expect(DIFFICULTIES.easy.snippetSec).toBeGreaterThan(DIFFICULTIES.medium.snippetSec);
    expect(DIFFICULTIES.medium.snippetSec).toBeGreaterThan(DIFFICULTIES.hard.snippetSec);
    expect(DIFFICULTIES.hard.points).toBeGreaterThan(DIFFICULTIES.easy.points);
  });
});

describe("scoring", () => {
  it("gives nothing for a wrong answer and more for a fast right one", () => {
    expect(pointsFor("easy", false, 1, 0)).toBe(0);
    const fast = pointsFor("easy", true, 1, 0);
    const slow = pointsFor("easy", true, 20, 0);
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThanOrEqual(DIFFICULTIES.easy.points / 2);
  });
  it("never pays less than half, even when time has run out", () => {
    expect(pointsFor("medium", true, 999, 0)).toBe(DIFFICULTIES.medium.points / 2);
  });
  it("adds a capped streak bonus", () => {
    const base = pointsFor("easy", true, 0, 0);
    expect(pointsFor("easy", true, 0, 2)).toBeGreaterThan(base);
    expect(pointsFor("easy", true, 0, 50)).toBe(Math.round(base * 1.5));
  });
  it("tracks the score, streaks and timeouts across a round", () => {
    const q = buildQuiz(library, { count: 4, difficulty: "easy", rng: seeded(2) });
    let score = emptyScore;
    const right = recordAnswer(score, q[0], q[0].correctIndex, "easy", 2);
    expect(right.correct).toBe(true);
    score = right.score;
    score = recordAnswer(score, q[1], q[1].correctIndex, "easy", 2).score;
    expect(score).toMatchObject({ correct: 2, answered: 2, streak: 2, bestStreak: 2 });
    const wrong = recordAnswer(score, q[2], (q[2].correctIndex + 1) % 4, "easy", 2);
    expect(wrong).toMatchObject({ correct: false, points: 0 });
    const timeout = recordAnswer(wrong.score, q[3], null, "easy", 25);
    expect(timeout.score).toMatchObject({ correct: 2, answered: 4, streak: 0, bestStreak: 2 });
  });
  it("has a verdict for every result", () => {
    expect(verdict(emptyScore)).toMatch(/No answers/);
    expect(verdict({ ...emptyScore, answered: 5, correct: 5 })).toMatch(/Perfect/);
    expect(verdict({ ...emptyScore, answered: 5, correct: 1 })).toMatch(/tricky/);
  });
});

describe("shuffle", () => {
  it("keeps every item and does not change the input", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input, seeded(4));
    expect(out.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
});