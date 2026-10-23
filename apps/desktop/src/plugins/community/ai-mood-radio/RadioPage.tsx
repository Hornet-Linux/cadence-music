import { AiError, AiGate } from "@/features/dj/AiUi";
import { connectedLookups, noSourceMessage } from "@/features/dj/multiSource";
import { usePlayer } from "@/player/playerStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { useJellyfin } from "@/plugins/builtins/jellyfin/jellyfinStore";
import { useSpotify } from "@/plugins/builtins/spotify/spotifyStore";
import { primaryArtist } from "@/shared/types";
import { ShuffleIcon } from "@/ui/icons";
import { MAX_CUSTOM_MOOD, MOODS } from "./mood";
import { useRadio } from "./store";
import "@/features/dj/ai.css";
import "./style.css";

export function RadioPage() {
  const radio = useRadio();
  // Re-render when a source connects or disconnects.
  useServer((s) => s.tracks.length);
  useJellyfin((s) => s.status?.connected);
  useSpotify((s) => s.status);
  const sources = connectedLookups();
  const current = usePlayer((s) => s.current);
  const on = radio.status !== "off";
  const busy = radio.status === "starting";

  return (
    <div className="view ai-radio">
      <header className="view-header">
        <h1>Mood radio</h1>
        <p className="muted">
          Pick a mood or an activity. The radio keeps the queue filled and learns from what you skip: skip a few in a row and it changes direction.
        </p>
      </header>

      <AiGate>
        {sources.length === 0 && <div className="notice warn">{noSourceMessage()}</div>}

        <div className="radio-moods" role="radiogroup" aria-label="Mood">
          {MOODS.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={radio.mood === m.id}
              className={`radio-mood${radio.mood === m.id ? " on" : ""}`}
              disabled={busy || sources.length === 0}
              onClick={() => void radio.start(m.id)}
            >
              <span className="radio-mood-name">{m.name}</span>
              <span className="radio-mood-blurb">{m.blurb}</span>
            </button>
          ))}
        </div>

        <form
          className="row radio-custom"
          onSubmit={(e) => {
            e.preventDefault();
            void radio.start("custom");
          }}
        >
          <input
            className="text-input"
            aria-label="Your own mood"
            value={radio.custom}
            maxLength={MAX_CUSTOM_MOOD}
            placeholder="Or your own: rainy late-night drive"
            onChange={(e) => radio.setCustom(e.target.value)}
          />
          <button className="btn" type="submit" disabled={busy || !radio.custom.trim() || sources.length === 0}>
            Start
          </button>
        </form>

        <label className="ai-check">
          <input type="checkbox" checked={radio.spoken} onChange={(e) => radio.setSpoken(e.target.checked)} /> Spoken intros between songs
        </label>

        {on && (
          <section className="radio-now" aria-live="polite">
            <div className="eyebrow">{busy ? "Starting…" : "On air"}</div>
            {current && !busy && (
              <div>
                <div className="strong">{current.title}</div>
                <div className="muted small">{primaryArtist(current)}</div>
              </div>
            )}
            <div className="muted small">
              {radio.finished} finished · {radio.skipped} skipped{radio.planning && !busy ? " · picking more songs…" : ""}
            </div>
            {radio.notice && <div className="ai-note">{radio.notice}</div>}
            <div className="ai-actions">
              <button className="btn" disabled={busy || radio.planning} onClick={() => void radio.changeDirection("Changing direction as you asked.")}>
                <ShuffleIcon size={16} /> Change direction
              </button>
              <button className="btn" onClick={() => radio.stop()}>
                Stop radio
              </button>
            </div>
          </section>
        )}
        {!on && radio.notice && <div className="notice">{radio.notice}</div>}
        <AiError error={radio.error} />
      </AiGate>
    </div>
  );
}
