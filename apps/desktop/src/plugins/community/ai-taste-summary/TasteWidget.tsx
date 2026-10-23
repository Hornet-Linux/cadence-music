import { useMemo, useState } from "react";
import { AiError, AiGate } from "@/features/dj/AiUi";
import { useHistory } from "@/features/history/historyStore";
import { MIN_PLAYS, aggregateLines, buildAggregates } from "./taste";
import { useTaste } from "./store";
import "@/features/dj/ai.css";
import "./style.css";

/** Home widget: your taste in three paragraphs, written only when you ask, from a summary of numbers. */
export function TasteWidget() {
  const { status, summary, error, generate, clear } = useTaste();
  const plays = useHistory((s) => s.plays);
  const [showData, setShowData] = useState(false);
  const lines = useMemo(() => (showData ? aggregateLines(buildAggregates(plays)) : []), [showData, plays]);
  const working = status === "working";
  const enough = plays.length >= MIN_PLAYS;

  return (
    <div className="stack taste">
      <p className="taste-privacy">
        <strong>Private by design.</strong> Your listening history never leaves this device. When you press the button, only a short
        summary of counts is sent to your AI provider: your most played artists and songs, and how your listening is spread over the
        day and week. Nothing is sent until you press it.
      </p>

      <AiGate>
        {!enough && (
          <p className="muted small">
            Play a few more songs first. A summary needs at least {MIN_PLAYS} plays; you have {plays.length}.
          </p>
        )}

        {summary && (
          <div className="taste-text" aria-live="polite">
            {summary.text.split("\n\n").map((p, i) => (
              <p key={i}>{p}</p>
            ))}
            <p className="ai-note">
              Written {new Date(summary.at).toLocaleDateString()} from {summary.plays} plays. AI summaries can be off the mark.
            </p>
          </div>
        )}
        <AiError error={error} />

        <div className="ai-actions">
          <button className="btn primary" disabled={working || !enough} onClick={() => void generate()}>
            {working ? "Writing…" : summary ? "Write it again" : "Summarize my taste"}
          </button>
          <button className="btn" aria-expanded={showData} onClick={() => setShowData((v) => !v)}>
            {showData ? "Hide what is sent" : "Show what is sent"}
          </button>
          {summary && !working && (
            <button className="btn ghost" onClick={clear}>
              Delete summary
            </button>
          )}
        </div>

        {showData && (
          <div className="taste-data">
            <p className="ai-note">This is everything the AI gets about you:</p>
            <ul>
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        )}
      </AiGate>
    </div>
  );
}
