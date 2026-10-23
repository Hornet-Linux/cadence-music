import { useState } from "react";
import { speakIntro, stopSpeaking } from "@/features/dj/voice";
import { isConfigured, PRESETS } from "./speech";
import { useTts } from "./store";
import "@/features/dj/ai.css";
import "./style.css";

const SAMPLE = "This is your Cadence DJ, speaking in the voice you chose. Here comes your next song.";

/** Settings → Neural voices: an OpenAI-compatible speech server for the DJ's spoken intros. */
export function TtsPanel() {
  const { config, hasKey, last, setConfig, setKey } = useTts();
  const [key, setKeyDraft] = useState("");
  const configured = isConfigured(config);

  return (
    <div className="stack tts-panel">
      <p className="muted small">
        The DJ&apos;s spoken intros can use a natural-sounding voice from any speech server that follows the OpenAI{" "}
        <code>/v1/audio/speech</code> API (OpenAI, Kokoro, Piper through openedai-speech and others). If it is off, unreachable or
        fails, the DJ falls back to your system voice, so an intro is never lost. Turn spoken intros on under Settings → AI DJ.
      </p>

      <div className="ai-chips" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.id} className="ai-chip" title={p.note} onClick={() => setConfig(p.config)}>
            {p.name}
          </button>
        ))}
      </div>

      <div className="ai-field">
        <label className="field-label" htmlFor="tts-url">
          Speech server address
        </label>
        <input
          id="tts-url"
          className="text-input"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={config.baseUrl}
          placeholder="http://localhost:8880/v1"
          onChange={(e) => setConfig({ baseUrl: e.target.value })}
        />
      </div>
      <div className="tts-grid">
        <div className="ai-field">
          <label className="field-label" htmlFor="tts-model">
            Model
          </label>
          <input id="tts-model" className="text-input" autoCapitalize="off" spellCheck={false} value={config.model} onChange={(e) => setConfig({ model: e.target.value })} />
        </div>
        <div className="ai-field">
          <label className="field-label" htmlFor="tts-voice">
            Voice
          </label>
          <input id="tts-voice" className="text-input" autoCapitalize="off" spellCheck={false} value={config.voice} onChange={(e) => setConfig({ voice: e.target.value })} />
        </div>
      </div>
      <div className="ai-field">
        <label className="field-label" htmlFor="tts-speed">
          Speed: {config.speed.toFixed(2)}
        </label>
        <input id="tts-speed" type="range" min={0.5} max={2} step={0.05} value={config.speed} onChange={(e) => setConfig({ speed: Number(e.target.value) })} />
      </div>
      <div className="ai-field">
        <label className="field-label" htmlFor="tts-key">
          API key (only if the server needs one)
        </label>
        <div className="row">
          <input
            id="tts-key"
            className="text-input"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={hasKey ? "Saved on this device" : "Optional"}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <button
            className="btn"
            disabled={!key.trim()}
            onClick={() => {
              void setKey(key.trim());
              setKeyDraft("");
            }}
          >
            Save
          </button>
          {hasKey && (
            <button className="btn ghost" onClick={() => void setKey(null)}>
              Remove
            </button>
          )}
        </div>
        <span className="ai-note">The key stays on this device. The speech server must allow requests from this app (CORS); local servers like Kokoro do by default.</span>
      </div>

      <div className="row tts-test">
        <button className="btn primary" disabled={!configured} onClick={() => speakIntro(SAMPLE)}>
          Test voice
        </button>
        <button className="btn ghost" onClick={stopSpeaking}>
          Stop
        </button>
      </div>
      {!configured && <p className="ai-note">Enter the speech server address to use a neural voice. Until then, system voices are used.</p>}
      {last && (
        <p className={`notice ${last.ok ? "" : "warn"}`} role="status">
          {last.ok
            ? "The last intro was spoken with the neural voice."
            : `The last intro used your system voice instead: ${last.message}`}
        </p>
      )}
    </div>
  );
}
