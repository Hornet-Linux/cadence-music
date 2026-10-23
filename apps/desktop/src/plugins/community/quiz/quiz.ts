import { primaryArtist, type Track } from "@/shared/types";

/** Guess-the-song quiz: building questions and scoring answers. No UI and no audio in here. */

export type Difficulty = "easy" | "medium" | "hard";

export interface DifficultyRules {
  label: string;
  /** How long the snippet plays, in seconds. */
  snippetSec: number;
  /** Seconds allowed to answer. */
  answerSec: number;
  /** Points for a perfect answer. */
  points: number;
  /** Wrong options come from the same artist or album when possible. */
  lookalikes: boolean;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyRules> = {
  easy: { label: "Easy", snippetSec: 15, answerSec: 25, points: 100, lookalikes: false },
  medium: { label: "Medium", snippetSec: 8, answerSec: 20, points: 150, lookalikes: false },
  hard: { label: "Hard", snippetSec: 3, answerSec: 12, points: 250, lookalikes: true },
};

/** Sources whose songs play through a plain audio element, so a snippet can be cut from them. */
const SNIPPET_SOURCES = new Set(["server", "local", "jellyfin"]);

export const OPTION_COUNT = 4;

const norm = (s: string) => s.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const artistKey = (t: Track) => norm(t.artists[0]?.name ?? "");
const titleKey = (t: Track) => norm(t.title);

/** A song can be quizzed when we know what it is called and its source can play a snippet. */
export function isQuizzable(t: Track): boolean {
  return t.title.trim().length > 0 && t.artists.length > 0 && (t.source === undefined || SNIPPET_SOURCES.has(t.source));
}

/** The label shown on an answer button. */
export function optionLabel(t: Track): string {
  return `${t.title} \u2013 ${primaryArtist(t)}`;
}

export interface Question {
  id: string;
  track: Track;
  /** Answer options, the right one among them. */
  options: Track[];
  correctIndex: number;
  /** Where in the song the snippet starts, in seconds. */
  startSec: number;
}

/** Why a quiz cannot be made from this library, or null if it can. */
export function quizProblem(library: Track[]): string | null {
  const usable = uniqueSongs(library.filter(isQuizzable));
  if (usable.length < OPTION_COUNT) {
    return usable.length === 0
      ? "The quiz needs songs from your server or local files. Add some music, then try again."
      : `The quiz needs at least ${OPTION_COUNT} different songs from your server or local files. You have ${usable.length}.`;
  }
  return null;
}

/** One entry per song (same title and artist counts once). */
export function uniqueSongs(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const t of tracks) {
    const key = `${titleKey(t)}|${artistKey(t)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Fisher-Yates shuffle with an injectable random source. */
export function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Start the snippet somewhere in the middle of the song, away from the quiet intro and the end. */
export function pickStart(durationSec: number | undefined, snippetSec: number, rng: () => number): number {
  if (!durationSec || durationSec < snippetSec * 2) return 0;
  const from = durationSec * 0.1;
  const to = Math.max(from, durationSec * 0.75 - snippetSec);
  return Math.round(from + rng() * (to - from));
}

function pickDistractors(answer: Track, pool: Track[], rules: DifficultyRules, rng: () => number): Track[] {
  const candidates = pool.filter((t) => t.id !== answer.id && titleKey(t) !== titleKey(answer));
  const similar = rules.lookalikes
    ? shuffle(
        candidates.filter((t) => artistKey(t) === artistKey(answer) || (!!t.album && t.album === answer.album)),
        rng,
      )
    : [];
  const chosen: Track[] = [];
  const labels = new Set([optionLabel(answer)]);
  const take = (list: Track[]) => {
    for (const t of list) {
      if (chosen.length >= OPTION_COUNT - 1) return;
      if (labels.has(optionLabel(t)) || chosen.some((c) => titleKey(c) === titleKey(t))) continue;
      labels.add(optionLabel(t));
      chosen.push(t);
    }
  };
  take(similar.slice(0, OPTION_COUNT - 2)); // keep at least one unrelated option
  const unrelated = shuffle(candidates.filter((t) => !similar.includes(t)), rng);
  take(unrelated);
  take(similar); // only if there were not enough unrelated songs
  return chosen;
}

/**
 * Build up to `count` questions from the library. Every question has four distinct options and
 * the same song never appears as an answer twice.
 */
export function buildQuiz(library: Track[], options: { count: number; difficulty: Difficulty; rng?: () => number }): Question[] {
  const rng = options.rng ?? Math.random;
  const rules = DIFFICULTIES[options.difficulty];
  const pool = uniqueSongs(library.filter(isQuizzable));
  if (pool.length < OPTION_COUNT) return [];
  const answers = shuffle(pool, rng).slice(0, Math.max(1, options.count));
  const questions: Question[] = [];
  for (const answer of answers) {
    const distractors = pickDistractors(answer, pool, rules, rng);
    if (distractors.length < OPTION_COUNT - 1) continue;
    const opts = shuffle([answer, ...distractors], rng);
    questions.push({
      id: `${answer.id}#${questions.length}`,
      track: answer,
      options: opts,
      correctIndex: opts.findIndex((t) => t.id === answer.id),
      startSec: pickStart(answer.durationSec, rules.snippetSec, rng),
    });
  }
  return questions;
}

export interface Score {
  points: number;
  correct: number;
  answered: number;
  streak: number;
  bestStreak: number;
}

export const emptyScore: Score = { points: 0, correct: 0, answered: 0, streak: 0, bestStreak: 0 };

/** Points for an answer: quicker is worth more, and each correct answer in a row adds a little. */
export function pointsFor(difficulty: Difficulty, correct: boolean, elapsedSec: number, streakBefore: number): number {
  if (!correct) return 0;
  const rules = DIFFICULTIES[difficulty];
  const left = Math.max(0, 1 - Math.max(0, elapsedSec) / rules.answerSec);
  const speed = 0.5 + 0.5 * left; // never less than half
  const streakBonus = 1 + Math.min(0.5, streakBefore * 0.1);
  return Math.round(rules.points * speed * streakBonus);
}

/** Record an answer. `choice` is null when time ran out. */
export function recordAnswer(score: Score, question: Question, choice: number | null, difficulty: Difficulty, elapsedSec: number): { score: Score; correct: boolean; points: number } {
  const correct = choice !== null && choice === question.correctIndex;
  const points = pointsFor(difficulty, correct, elapsedSec, score.streak);
  const streak = correct ? score.streak + 1 : 0;
  return {
    correct,
    points,
    score: {
      points: score.points + points,
      correct: score.correct + (correct ? 1 : 0),
      answered: score.answered + 1,
      streak,
      bestStreak: Math.max(score.bestStreak, streak),
    },
  };
}

/** A friendly line for the end of a round. */
export function verdict(score: Score): string {
  if (score.answered === 0) return "No answers this round.";
  const ratio = score.correct / score.answered;
  if (ratio === 1) return "Perfect. You know your music.";
  if (ratio >= 0.8) return "Very good ear.";
  if (ratio >= 0.5) return "Not bad. Try a harder level?";
  return "A tricky round. Another go?";
}