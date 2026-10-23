import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { primaryArtist } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { useLibraryTracks } from "../_social/libraryTracks";
import { Notice, Page, Tabs } from "../_social/ui";
import {
  buildQuiz,
  DIFFICULTIES,
  emptyScore,
  optionLabel,
  quizProblem,
  recordAnswer,
  verdict,
  type Difficulty,
  type Question,
  type Score,
} from "./quiz";
import { SnippetPlayer, type SnippetState } from "./snippet";
import "./style.css";

export const QUIZ_ITEM_ID = "quiz";

type Phase = "setup" | "playing" | "revealed" | "done";

export function QuizPage() {
  const library = useLibraryTracks({ includeHistory: false });
  const problem = useMemo(() => quizProblem(library), [library]);
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [count, setCount] = useState(10);
  const [phase, setPhase] = useState<Phase>("setup");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [index, setIndex] = useState(0);
  const [score, setScore] = useState<Score>(emptyScore);
  const [choice, setChoice] = useState<number | null>(null);
  const [last, setLast] = useState<{ correct: boolean; points: number } | null>(null);
  const [snippet, setSnippet] = useState<SnippetState>("idle");
  const [skipped, setSkipped] = useState(0);
  const [left, setLeft] = useState(0);
  const startedAt = useRef(0);
  const player = useRef<SnippetPlayer | null>(null);
  const rules = DIFFICULTIES[difficulty];
  const question = questions[index];

  useEffect(() => {
    const p = new SnippetPlayer(setSnippet);
    player.current = p;
    return () => {
      p.dispose();
      player.current = null;
    };
  }, []);

  const playSnippet = useCallback(
    async (q: Question) => {
      const ok = await player.current?.play(q.track, q.startSec, rules.snippetSec);
      return ok !== false;
    },
    [rules.snippetSec],
  );

  const begin = useCallback(
    async (qs: Question[], i: number) => {
      setIndex(i);
      setChoice(null);
      setLast(null);
      setPhase("playing");
      startedAt.current = Date.now();
      setLeft(rules.answerSec);
      const ok = await playSnippet(qs[i]);
      if (!ok) {
        // This song cannot be played here: move on without counting it.
        setSkipped((n) => n + 1);
        if (i + 1 < qs.length) void begin(qs, i + 1);
        else setPhase("done");
      }
    },
    [playSnippet, rules.answerSec],
  );

  const start = () => {
    // Quiet the main player so the snippets are the only thing playing.
    const main = usePlayer.getState();
    if (main.isPlaying) main.toggle();
    const qs = buildQuiz(library, { count, difficulty });
    setQuestions(qs);
    setScore(emptyScore);
    setSkipped(0);
    if (qs.length === 0) return;
    void begin(qs, 0);
  };

  const answer = useCallback(
    (picked: number | null) => {
      if (phase !== "playing" || !question) return;
      const elapsed = (Date.now() - startedAt.current) / 1000;
      const result = recordAnswer(score, question, picked, difficulty, elapsed);
      player.current?.stop();
      setScore(result.score);
      setChoice(picked);
      setLast({ correct: result.correct, points: result.points });
      setPhase("revealed");
    },
    [phase, question, score, difficulty],
  );

  // Countdown for the answer window.
  useEffect(() => {
    if (phase !== "playing") return;
    const timer = setInterval(() => {
      const remaining = rules.answerSec - (Date.now() - startedAt.current) / 1000;
      setLeft(Math.max(0, remaining));
      if (remaining <= 0) answer(null);
    }, 200);
    return () => clearInterval(timer);
  }, [phase, rules.answerSec, answer]);

  const next = () => {
    if (index + 1 < questions.length) void begin(questions, index + 1);
    else {
      player.current?.stop();
      setPhase("done");
    }
  };

  const reset = () => {
    player.current?.stop();
    setPhase("setup");
  };

  return (
    <Page className="qz-page" title="Song quiz" subtitle="Hear a few seconds of a song from your library and pick the right title.">
      {phase === "setup" && (
        <div className="sx-stack">
          {problem && <Notice kind="warn">{problem}</Notice>}
          <section className="sx-card">
            <h2>Difficulty</h2>
            <Tabs
              label="Difficulty"
              value={difficulty}
              onChange={setDifficulty}
              options={(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => ({ id: d, label: DIFFICULTIES[d].label }))}
            />
            <p className="muted small" style={{ marginTop: 8 }}>
              {rules.snippetSec}-second snippets, {rules.answerSec} seconds to answer
              {rules.lookalikes ? ", and wrong answers that look like the right one" : ""}.
            </p>
            <h2 style={{ marginTop: 16 }}>Questions</h2>
            <Tabs
              label="Number of questions"
              value={String(count)}
              onChange={(v) => setCount(Number(v))}
              options={["5", "10", "15"].map((n) => ({ id: n, label: n }))}
            />
          </section>
          <div>
            <button className="btn primary big" disabled={!!problem} onClick={start}>
              Start quiz
            </button>
          </div>
          <p className="muted small">Uses songs from your server and local files. Songs on Spotify or Apple Music have no snippets here. Your player is paused while you play.</p>
        </div>
      )}

      {(phase === "playing" || phase === "revealed") && question && (
        <div className="sx-stack qz-play">
          <div className="sx-row qz-meta">
            <span>
              Question {index + 1} of {questions.length}
            </span>
            <span className="sx-grow" />
            <span aria-label="Score">{score.points} pts</span>
            {score.streak > 1 && <span className="muted small">{score.streak} in a row</span>}
          </div>
          <div className="qz-clock" role="progressbar" aria-label="Time left" aria-valuemin={0} aria-valuemax={rules.answerSec} aria-valuenow={Math.round(phase === "playing" ? left : 0)}>
            <span style={{ width: `${phase === "playing" ? (left / rules.answerSec) * 100 : 0}%` }} />
          </div>
          <section className="sx-card qz-stage">
            {phase === "playing" ? (
              <>
                <div className={`qz-wave ${snippet}`} aria-hidden>
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <p className="muted" role="status">
                  {snippet === "loading" ? "Loading..." : snippet === "playing" ? "Listen..." : "Snippet finished."}
                </p>
                <button className="btn" onClick={() => void playSnippet(question)} disabled={snippet === "loading"}>
                  Hear it again
                </button>
              </>
            ) : (
              <div className="qz-reveal">
                <span className="qz-cover">
                  <CoverArt src={question.track.artwork} seed={question.track.album ?? question.track.title} label={question.track.title} />
                </span>
                <div>
                  <div className="strong" role="status">
                    {last?.correct ? `Correct, +${last.points}` : choice === null ? "Time's up" : "Not quite"}
                  </div>
                  <div className="sx-title">{question.track.title}</div>
                  <div className="sx-sub">{primaryArtist(question.track)}</div>
                </div>
              </div>
            )}
          </section>
          <div className="qz-options" role="group" aria-label="Answers">
            {question.options.map((o, i) => {
              const state =
                phase === "revealed" ? (i === question.correctIndex ? "right" : i === choice ? "wrong" : "dim") : "";
              return (
                <button key={o.id} className={`qz-option ${state}`} disabled={phase === "revealed"} onClick={() => answer(i)}>
                  <span className="qz-letter">{"ABCD"[i]}</span>
                  <span className="qz-label">{optionLabel(o)}</span>
                </button>
              );
            })}
          </div>
          {phase === "revealed" && (
            <div className="sx-row">
              <button className="btn primary" onClick={next}>
                {index + 1 < questions.length ? "Next" : "See result"}
              </button>
              <button className="btn ghost" onClick={reset}>
                Quit
              </button>
            </div>
          )}
        </div>
      )}

      {phase === "done" && (
        <section className="sx-card qz-done">
          <div className="eyebrow">Round complete</div>
          <div className="qz-big">{score.points} points</div>
          <p>
            {score.correct} of {score.answered} right{score.bestStreak > 1 ? `, best run ${score.bestStreak}` : ""}.
          </p>
          <p className="muted">{verdict(score)}</p>
          {skipped > 0 && <p className="muted small">{skipped} song{skipped === 1 ? "" : "s"} couldn't be played and {skipped === 1 ? "was" : "were"} skipped.</p>}
          <div className="sx-row">
            <button className="btn primary" onClick={start}>
              Play again
            </button>
            <button className="btn" onClick={reset}>
              Change settings
            </button>
          </div>
        </section>
      )}
    </Page>
  );
}