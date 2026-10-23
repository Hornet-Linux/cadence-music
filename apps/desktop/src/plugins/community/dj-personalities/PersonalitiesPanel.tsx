import { useEffect, useState } from "react";
import { speakIntro, stopSpeaking } from "@/features/dj/voice";
import {
  CUSTOM_ID,
  MAX_NAME,
  MAX_STYLE,
  MAX_VOICE_HINT,
  PRESETS,
  resolvePersonality,
  sanitizeCustom,
  type CustomPersonality,
} from "./personalities";
import { usePersonality } from "./store";
import "@/features/dj/ai.css";
import "./style.css";

/** Settings → DJ personalities: pick a host, or write your own. */
export function PersonalitiesPanel() {
  const { selected, custom, select, saveCustom } = usePersonality();
  const [draft, setDraft] = useState<CustomPersonality>(custom);
  const active = resolvePersonality({ selected, custom });

  useEffect(() => setDraft(custom), [custom]);
  useEffect(() => stopSpeaking, []);

  const dirty = JSON.stringify(sanitizeCustom(draft)) !== JSON.stringify(custom);
  const set = <K extends keyof CustomPersonality>(key: K, value: CustomPersonality[K]) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="stack dj-persona">
      <p className="muted small">
        The host changes how the DJ words its intros and how they sound. It applies the next time the DJ picks songs; turn the DJ off
        and on, or press Switch it up, to hear it straight away.
      </p>

      <div className="persona-list" role="radiogroup" aria-label="DJ host">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={selected === p.id}
            className={`persona-card${selected === p.id ? " on" : ""}`}
            onClick={() => select(p.id)}
          >
            <span className="persona-name">{p.name}</span>
            <span className="persona-blurb">{p.blurb}</span>
          </button>
        ))}
        <button
          role="radio"
          aria-checked={selected === CUSTOM_ID}
          className={`persona-card${selected === CUSTOM_ID ? " on" : ""}`}
          onClick={() => select(CUSTOM_ID)}
        >
          <span className="persona-name">{custom.name || "My host"}</span>
          <span className="persona-blurb">Write your own host below.</span>
        </button>
      </div>

      <div className="row persona-hear">
        <button className="btn" onClick={() => speakIntro(active.sample)}>
          Hear {active.name}
        </button>
        <span className="muted small">Uses your system voice, or your neural voice if that plugin is on.</span>
      </div>

      <h3 className="settings-subhead">Your own host</h3>
      <div className="ai-field">
        <label className="field-label" htmlFor="persona-name">
          Name
        </label>
        <input
          id="persona-name"
          className="text-input"
          value={draft.name}
          maxLength={MAX_NAME}
          onChange={(e) => set("name", e.target.value)}
        />
      </div>
      <div className="ai-field">
        <label className="field-label" htmlFor="persona-style">
          How should the host talk? ({draft.style.length}/{MAX_STYLE})
        </label>
        <textarea
          id="persona-style"
          className="text-input"
          value={draft.style}
          maxLength={MAX_STYLE}
          placeholder="e.g. a grumpy but lovable record-shop owner who is secretly very proud of the listener's taste"
          onChange={(e) => set("style", e.target.value)}
        />
      </div>
      <div className="ai-field">
        <label className="field-label" htmlFor="persona-rate">
          Speaking speed: {draft.rate.toFixed(2)}
        </label>
        <input id="persona-rate" type="range" min={0.6} max={1.5} step={0.05} value={draft.rate} onChange={(e) => set("rate", Number(e.target.value))} />
      </div>
      <div className="ai-field">
        <label className="field-label" htmlFor="persona-pitch">
          Pitch: {draft.pitch.toFixed(2)} <span className="muted">(system voices only)</span>
        </label>
        <input id="persona-pitch" type="range" min={0.5} max={1.5} step={0.05} value={draft.pitch} onChange={(e) => set("pitch", Number(e.target.value))} />
      </div>
      <div className="ai-field">
        <label className="field-label" htmlFor="persona-voice">
          Preferred voice (optional)
        </label>
        <input
          id="persona-voice"
          className="text-input"
          value={draft.voiceHint}
          maxLength={MAX_VOICE_HINT}
          placeholder="Part of a voice name, e.g. Samantha or Natural"
          onChange={(e) => set("voiceHint", e.target.value)}
        />
      </div>
      <div className="row">
        <button className="btn primary" disabled={!dirty && selected === CUSTOM_ID} onClick={() => saveCustom(draft)}>
          {selected === CUSTOM_ID ? "Save changes" : "Save and use"}
        </button>
        {selected === CUSTOM_ID && !dirty && <span className="muted small">Saved.</span>}
      </div>
    </div>
  );
}
