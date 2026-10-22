import { useState } from "react";
import { PRESETS, presetById, type LlmStatus, type ProviderKind } from "../../../electron/llm";
import { SettingRow, Toggle } from "@/features/settings/controls";

export interface ProviderFormValue {
  preset: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  /** Empty keeps the saved key (or none). */
  apiKey: string;
  clearKey: boolean;
  share: boolean;
}

export const EMPTY_FORM: ProviderFormValue = {
  preset: "ollama",
  name: "Ollama",
  kind: "ollama",
  baseUrl: "http://localhost:11434",
  model: "llama3.2:3b",
  apiKey: "",
  clearKey: false,
  share: false,
};

interface Props {
  initial?: ProviderFormValue;
  /** Where the key ends up, shown under the key field. */
  keyNote: string;
  /** Offer "share with my other devices" (device providers while signed in). */
  canShare?: boolean;
  hasKey?: boolean;
  onSave: (value: ProviderFormValue) => Promise<void>;
  onTest: (value: ProviderFormValue) => Promise<LlmStatus>;
  onCancel: () => void;
}

/** Add or edit a provider: pick a preset, fill in the address, model and key. */
export function ProviderForm({ initial = EMPTY_FORM, keyNote, canShare, hasKey, onSave, onTest, onCancel }: Props) {
  const [v, setV] = useState(initial);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<ProviderFormValue>) => setV((cur) => ({ ...cur, ...p }));
  const preset = presetById(v.preset);

  function choosePreset(id: string) {
    const p = presetById(id);
    if (!p) return;
    patch({ preset: id, kind: p.kind, baseUrl: p.baseUrl, name: p.id === "custom" ? v.name : p.name, model: p.defaultModel ?? "" });
    setStatus(null);
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const valid = v.name.trim() && v.baseUrl.trim() && v.model.trim();

  return (
    <div className="stack provider-form">
      <SettingRow title="Provider" description="Pick a service, or “Other” for any OpenAI-compatible server.">
        <select className="text-input" value={v.preset} aria-label="Provider type" onChange={(e) => choosePreset(e.target.value)}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="Name">
        <input className="text-input" value={v.name} aria-label="Name" onChange={(e) => patch({ name: e.target.value })} />
      </SettingRow>
      <SettingRow title="Address" description="The server's base URL, e.g. http://localhost:1234/v1">
        <input
          className="text-input"
          value={v.baseUrl}
          spellCheck={false}
          aria-label="Address"
          onChange={(e) => (patch({ baseUrl: e.target.value }), setStatus(null))}
        />
      </SettingRow>
      <SettingRow title="Model" description={status?.available ? "Pick one the server has, or type a name." : "Press Test to list the models it has."}>
        <input
          className="text-input"
          list="provider-models"
          value={v.model}
          spellCheck={false}
          aria-label="Model"
          onChange={(e) => patch({ model: e.target.value })}
        />
        <datalist id="provider-models">{status?.models.map((m) => <option key={m} value={m} />)}</datalist>
      </SettingRow>
      {(preset?.needsKey || v.apiKey || hasKey) && (
        <SettingRow title="API key" description={keyNote}>
          <input
            className="text-input"
            type="password"
            autoComplete="off"
            value={v.apiKey}
            aria-label="API key"
            placeholder={hasKey && !v.clearKey ? "Saved. Leave blank to keep it" : ""}
            onChange={(e) => patch({ apiKey: e.target.value, clearKey: false })}
          />
          {hasKey && (
            <button className="btn ghost" onClick={() => patch({ clearKey: !v.clearKey, apiKey: "" })}>
              {v.clearKey ? "Keep saved key" : "Remove saved key"}
            </button>
          )}
        </SettingRow>
      )}
      {canShare && (
        <SettingRow
          title="Share with my other devices"
          description="Lets your phone and other computers use this provider through the server while this app is open. Your key never leaves this device."
        >
          <Toggle on={v.share} onChange={(share) => patch({ share })} label="Share with my other devices" />
        </SettingRow>
      )}

      {status && (
        <p className={`notice${status.available ? "" : " warn"}`}>
          {status.available
            ? `Connected. ${status.models.length} model${status.models.length === 1 ? "" : "s"} available.`
            : `Couldn't connect${status.error ? `: ${status.error}` : "."}`}
        </p>
      )}
      {error && <p className="notice error">{error}</p>}

      <div className="row">
        <button className="btn" disabled={busy || !valid} onClick={() => void run(() => onSave(v))}>
          Save
        </button>
        <button className="btn ghost" disabled={busy || !v.baseUrl.trim()} onClick={() => void run(async () => setStatus(await onTest(v)))}>
          Test
        </button>
        <button className="btn ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
