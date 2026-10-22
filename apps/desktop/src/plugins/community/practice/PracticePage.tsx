import { useRef } from "react";
import { usePlayer } from "@/player/playerStore";
import { primaryArtist } from "@/shared/types";
import { Notice, Page } from "../_social/ui";
import { usePractice } from "./engine";
import { formatTime, isActive, MAX_BPM, MAX_RATE, MIN_BPM, MIN_RATE, RATES, tapTempo } from "./loop";
import "./style.css";

export const PRACTICE_ITEM_ID = "practice";

function Nudge({ point }: { point: "a" | "b" }) {
  const nudgePoint = usePractice((s) => s.nudgePoint);
  return (
    <span className="pr-nudge" role="group" aria-label={`Fine-tune point ${point.toUpperCase()}`}>
      <button className="btn" onClick={() => nudgePoint(point, -0.1)} aria-label={`Move ${point.toUpperCase()} earlier by a tenth of a second`}>
        -0.1
      </button>
      <button className="btn" onClick={() => nudgePoint(point, 0.1)} aria-label={`Move ${point.toUpperCase()} later by a tenth of a second`}>
        +0.1
      </button>
    </span>
  );
}

export function PracticePage() {
  const current = usePlayer((s) => s.current);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const seek = usePlayer((s) => s.seek);
  const p = usePractice();
  const taps = useRef<number[]>([]);
  const external = usePlayer((s) => s.engine) === "external";
  const loop = p.loop;
  const pct = (t: number | null) => (t !== null && duration > 0 ? `${Math.min(100, (t / duration) * 100)}%` : "0%");

  return (
    <Page title="Practice" subtitle="Loop a hard section, slow it down and count yourself in.">
      {!current ? (
        <div className="sx-card">
          <p>Play a song first.</p>
          <p className="muted small">Then mark a section with A and B, and it repeats until you turn the loop off.</p>
        </div>
      ) : (
        <div className="sx-stack">
          <section className="sx-card">
            <div className="sx-title">{current.title}</div>
            <div className="sx-sub">{primaryArtist(current)}</div>
            <div className="pr-timeline" aria-hidden={duration <= 0}>
              {loop.a !== null && loop.b !== null && <span className={`pr-region${isActive(loop) ? " on" : ""}`} style={{ left: pct(loop.a), width: `calc(${pct(loop.b)} - ${pct(loop.a)})` }} />}
              {loop.a !== null && <span className="pr-mark" style={{ left: pct(loop.a) }} data-label="A" />}
              {loop.b !== null && <span className="pr-mark" style={{ left: pct(loop.b) }} data-label="B" />}
              <input
                type="range"
                className="pr-slider"
                min={0}
                max={Math.max(1, duration)}
                step={0.1}
                value={Math.min(position, Math.max(1, duration))}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Playback position"
              />
            </div>
            <div className="sx-row pr-times">
              <span>{formatTime(position)}</span>
              <span className="sx-grow" />
              <span className="muted">{formatTime(duration)}</span>
            </div>
          </section>

          <section className="sx-card">
            <h2>Loop</h2>
            <div className="pr-points">
              <div className="pr-point">
                <button className="btn" onClick={p.markA}>
                  Set A here
                </button>
                <span className="pr-time">{formatTime(loop.a)}</span>
                <Nudge point="a" />
              </div>
              <div className="pr-point">
                <button className="btn" onClick={p.markB}>
                  Set B here
                </button>
                <span className="pr-time">{formatTime(loop.b)}</span>
                <Nudge point="b" />
              </div>
            </div>
            <div className="sx-row" style={{ marginTop: 12 }}>
              <button className="btn" aria-pressed={loop.enabled} disabled={loop.a === null || loop.b === null} onClick={p.toggleLoop}>
                {loop.enabled ? "Looping" : "Loop off"}
              </button>
              <button className="btn" disabled={!isActive(loop)} onClick={() => isActive(loop) && seek(loop.a)}>
                Jump to A
              </button>
              <button className="btn ghost" disabled={loop.a === null && loop.b === null} onClick={p.clearLoop}>
                Clear
              </button>
            </div>
            {external && (
              <p className="muted small" style={{ marginTop: 10 }}>
                This song plays through {current.source === "spotify" ? "Spotify" : "Apple Music"}, which reports its position about once a second, so the loop may land up to a second early or late.
              </p>
            )}
          </section>

          <section className="sx-card">
            <h2>Speed {Math.round(p.rate * 100)}%</h2>
            {external ? (
              <Notice kind="warn">
                Slow-down works for songs from your server and local files. {current.source === "spotify" ? "Spotify" : "Apple Music"} plays this song in its own player, which can't change speed.
              </Notice>
            ) : (
              <>
                <div className="pr-rates" role="group" aria-label="Speed presets">
                  {RATES.map((r) => (
                    <button key={r} className="btn" aria-pressed={Math.abs(p.rate - r) < 0.005} onClick={() => p.setRate(r)}>
                      {Math.round(r * 100)}%
                    </button>
                  ))}
                </div>
                <input
                  type="range"
                  className="pr-slider"
                  min={MIN_RATE}
                  max={MAX_RATE}
                  step={0.01}
                  value={p.rate}
                  onChange={(e) => p.setRate(Number(e.target.value))}
                  aria-label="Playback speed"
                />
                <p className="muted small">Pitch stays the same. The speed resets to 100% when you turn this plugin off.</p>
              </>
            )}
          </section>

          <section className="sx-card">
            <h2>Count-in</h2>
            <div className="pr-count">
              <label className="pr-field">
                <span className="field-label">Tempo (BPM)</span>
                <input className="text-input" type="number" inputMode="numeric" min={MIN_BPM} max={MAX_BPM} value={p.bpm} onChange={(e) => p.setBpm(Number(e.target.value))} />
              </label>
              <button
                className="btn"
                onClick={() => {
                  const now = Date.now();
                  taps.current = [...taps.current.filter((t) => now - t < 5000), now];
                  const bpm = tapTempo(taps.current);
                  if (bpm) p.setBpm(bpm);
                }}
              >
                Tap tempo
              </button>
              <label className="pr-field">
                <span className="field-label">Beats</span>
                <select className="text-input" value={p.beats} onChange={(e) => p.setBeats(Number(e.target.value))}>
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="sx-row" style={{ marginTop: 12 }}>
              <button className="btn primary" disabled={p.countingIn} onClick={() => void p.countInAndPlay()}>
                {p.countingIn ? "Counting in..." : isActive(loop) ? "Count in, play from A" : "Count in and play"}
              </button>
              <label className="pr-check">
                <input type="checkbox" checked={p.countInEachLoop} onChange={(e) => p.setCountInEachLoop(e.target.checked)} />
                <span>Count in every repeat</span>
              </label>
            </div>
          </section>
        </div>
      )}
    </Page>
  );
}