import { usePlayer } from "@/player/playerStore";
import { primaryArtist } from "@/shared/types";
import { PlayIcon, ShuffleIcon, SparkleIcon } from "@/ui/icons";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useDj } from "./djStore";
import { useAnyDjSource } from "./sources";

/** Home banner that starts, steers and stops the AI DJ. Shown once Spotify or Jellyfin is connected. */
export function DjCard() {
  const hasSource = useAnyDjSource();
  const showSettings = useSettingsModal((s) => s.show);
  const { status, error, needsSetup, mood, intros, voice, setMood, setVoice, start, switchUp, stop } = useDj();
  const current = usePlayer((s) => s.current);
  if (!hasSource) return null;

  const thinking = status === "thinking";
  const live = status !== "idle";
  const intro = current ? intros[current.id] : undefined;

  return (
    <section className={`hero dj${live ? " live" : ""}`} aria-busy={thinking}>
      <div className="hero-text">
        <span className="eyebrow">
          <SparkleIcon size={12} /> AI DJ{live ? " · on air" : ""}
        </span>
        {live && current && intro ? (
          <>
            <h2>{current.title}</h2>
            <p className="dj-intro">
              {primaryArtist(current)} — “{intro}”
            </p>
          </>
        ) : (
          <>
            <h2>{thinking ? "Picking your songs…" : "Your personal DJ"}</h2>
            <p>A nonstop mix picked from what you love, plus a few new finds.</p>
          </>
        )}
        {!live && (
          <input
            className="text-input dj-mood"
            placeholder="Any mood? e.g. rainy afternoon, workout, 90s"
            value={mood}
            maxLength={120}
            onChange={(e) => setMood(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void start()}
          />
        )}
        <div className="dj-actions">
          {live ? (
            <>
              <button className="btn primary" disabled={thinking} onClick={() => void switchUp()}>
                <ShuffleIcon size={16} /> Switch it up
              </button>
              <button className="btn" onClick={stop}>
                Stop DJ
              </button>
            </>
          ) : (
            <button className="btn primary big" onClick={() => void start()}>
              <PlayIcon size={18} /> Start DJ
            </button>
          )}
          <label className="dj-voice">
            <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Spoken intros
          </label>
        </div>
        {error && (
          <p className="dj-error" role="alert">
            {error}{" "}
            {needsSetup && (
              <button className="btn ghost" onClick={() => showSettings("dj")}>
                Set up the DJ
              </button>
            )}
          </p>
        )}
      </div>
    </section>
  );
}
