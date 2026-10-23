import { useState } from "react";
import { Toggle } from "@/features/settings/controls";
import { Chips, Note, Row, Section, Slider } from "../_audio-kit/ui";
import {
  BAND_FREQS,
  BUILT_IN_PRESETS,
  MAX_GAIN_DB,
  MAX_PREAMP_DB,
  formatDb,
  formatHz,
  matchPreset,
  responseCurve,
  savePreset,
  type EqPreset,
} from "./eq";
import { eqPrefs } from "./engine";
import "./style.css";

const W = 300;
const H = 90;
const RANGE = 16; // dB shown either side of 0

function Curve({ gains, preamp, on }: { gains: number[]; preamp: number; on: boolean }) {
  const pts = responseCurve(on ? gains : gains.map(() => 0), on ? preamp : 0, 48);
  const lo = Math.log10(20);
  const hi = Math.log10(20000);
  const x = (f: number) => ((Math.log10(f) - lo) / (hi - lo)) * W;
  const y = (db: number) => H / 2 - (Math.max(-RANGE, Math.min(RANGE, db)) / RANGE) * (H / 2);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.f).toFixed(1)} ${y(p.db).toFixed(1)}`).join(" ");
  return (
    <svg className="eq-curve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Equalizer response curve" preserveAspectRatio="none">
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="eq-zero" />
      <path d={d} className="eq-line" fill="none" />
    </svg>
  );
}

export function EqPanel() {
  const s = eqPrefs.use();
  const [name, setName] = useState("");
  const all: EqPreset[] = [...BUILT_IN_PRESETS, ...s.custom];

  const apply = (presetName: string) => {
    const p = all.find((x) => x.name === presetName);
    if (p) eqPrefs.set({ preset: p.name, preamp: p.preamp, gains: [...p.gains] });
  };
  const setBand = (i: number, value: number) => {
    const gains = s.gains.map((g, j) => (j === i ? value : g));
    eqPrefs.set({ gains, preset: matchPreset(s.preamp, gains, s.custom) });
  };
  const setPreamp = (preamp: number) => eqPrefs.set({ preamp, preset: matchPreset(preamp, s.gains, s.custom) });
  const save = () => {
    const custom = savePreset(s.custom, name, s.preamp, s.gains);
    if (custom === s.custom) return;
    const saved = custom[custom.length - 1];
    eqPrefs.set({ custom, preset: saved.name });
    setName("");
  };
  const nameTaken = BUILT_IN_PRESETS.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());

  return (
    <div className="ax">
      <Row title="Equalizer" description="Shape the sound of everything Cadence plays itself.">
        <Toggle on={s.on} onChange={(on) => eqPrefs.set({ on })} label="Equalizer on" />
      </Row>

      <Curve gains={s.gains} preamp={s.preamp} on={s.on} />

      <Section title="Presets">
        <Chips
          label="Equalizer presets"
          options={all.map((p) => ({ value: p.name, label: p.name }))}
          value={s.preset || null}
          onChange={apply}
        />
        {!s.preset && <p className="ax-hint">Custom curve</p>}
      </Section>

      <Section title="Level">
        <Slider
          label="Preamp"
          value={s.preamp}
          min={-MAX_PREAMP_DB}
          max={MAX_PREAMP_DB}
          step={0.5}
          format={formatDb}
          onChange={setPreamp}
          disabled={!s.on}
          hint="Lower this if boosted music sounds harsh or crackles."
        />
      </Section>

      <Section title="Bands">
        <div className="eq-bands">
          {BAND_FREQS.map((f, i) => (
            <Slider
              key={f}
              label={formatHz(f)}
              value={s.gains[i] ?? 0}
              min={-MAX_GAIN_DB}
              max={MAX_GAIN_DB}
              step={0.5}
              format={formatDb}
              onChange={(v) => setBand(i, v)}
              disabled={!s.on}
            />
          ))}
        </div>
        <button type="button" className="ax-btn quiet" onClick={() => apply("Flat")} disabled={!s.on}>
          Reset to flat
        </button>
      </Section>

      <Section title="Save your own">
        <div className="ax-inline">
          <input
            className="ax-input"
            placeholder="Preset name"
            value={name}
            maxLength={32}
            aria-label="Name for the custom preset"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          <button type="button" className="ax-btn" onClick={save} disabled={!name.trim() || nameTaken}>
            Save preset
          </button>
        </div>
        {nameTaken && <p className="ax-hint">That name belongs to a built-in preset.</p>}
        {s.custom.length > 0 && (
          <ul className="eq-custom">
            {s.custom.map((p) => (
              <li key={p.name}>
                <span>{p.name}</span>
                <button
                  type="button"
                  className="ax-btn quiet"
                  aria-label={`Delete preset ${p.name}`}
                  onClick={() =>
                    eqPrefs.set({
                      custom: s.custom.filter((c) => c.name !== p.name),
                      preset: s.preset === p.name ? "" : s.preset,
                    })
                  }
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Note>
        The equalizer works on music Cadence plays itself (your server and files on this device). Spotify and Apple Music play
        inside their own players, which a web page cannot process.
      </Note>
    </div>
  );
}
