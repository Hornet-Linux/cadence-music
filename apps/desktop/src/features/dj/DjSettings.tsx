import { useCallback, useEffect, useState } from "react";
import { DEFAULT_LLM_CONFIG, type LlmStatus } from "../../../electron/llm";
import { SettingRow, Toggle } from "@/features/settings/controls";
import { useDj } from "./djStore";
import { djSetup, OLLAMA_DOWNLOAD_URL } from "./setup";

/** Settings → AI DJ: voice, Ollama address and model, with setup help. */
export function DjSettings() {
  const { config, voice, setConfig, setVoice } = useDj();
  const [url, setUrl] = useState(config.baseUrl);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    const llm = window.host?.llm;
    if (!llm) return setStatus({ available: false, models: [], error: "Not available in this build" });
    setChecking(true);
    try {
      setStatus(await llm.status(useDj.getState().config));
    } catch (e) {
      setStatus({ available: false, models: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check, config.baseUrl]);

  const saveUrl = () => {
    const baseUrl = url.trim() || DEFAULT_LLM_CONFIG.baseUrl;
    setUrl(baseUrl);
    if (baseUrl !== config.baseUrl) setConfig({ ...config, baseUrl });
  };

  const setup = status ? djSetup(config, status) : null;
  const models = status?.models.includes(config.model) ? status.models : [config.model, ...(status?.models ?? [])];
  const web = window.host?.platform === ("web" as string);

  return (
    <div className="stack">
      <SettingRow title="Spoken intros" description="The DJ talks over the start of each song, with the music turned down.">
        <Toggle on={voice} onChange={setVoice} label="Spoken intros" />
      </SettingRow>

      <SettingRow title="Ollama address" description="Where Ollama is running. Usually this computer.">
        <input
          className="text-input"
          value={url}
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={saveUrl}
          onKeyDown={(e) => e.key === "Enter" && saveUrl()}
        />
      </SettingRow>

      <SettingRow title="Model" description="Bigger models pick better songs but need more memory and are slower. llama3.2:3b runs on most computers.">
        <div className="row">
          <select
            className="text-input"
            value={config.model}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
            aria-label="Model"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button className="btn ghost" disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>
      </SettingRow>

      {setup?.kind === "ready" && <p className="notice">Ollama is running and {config.model} is ready.</p>}

      {setup?.kind === "no-ollama" && (
        <div className="notice warn">
          <p>
            <strong>Ollama isn't running.</strong> The DJ uses Ollama to pick songs on your own computer, so nothing about
            your listening leaves it.
          </p>
          <ol className="steps">
            <li>
              Download and install Ollama from{" "}
              <a href={OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                ollama.com/download
              </a>
              .
            </li>
            <li>
              In a terminal, run <code>ollama pull {config.model}</code>.
            </li>
            {web && (
              <li>
                Allow this site to reach Ollama by setting <code>OLLAMA_ORIGINS={location.origin}</code> and
                restarting it.
              </li>
            )}
            <li>Press “Check again”.</li>
          </ol>
          {setup.detail && <p className="muted small">Details: {setup.detail}</p>}
        </div>
      )}

      {setup?.kind === "no-model" && (
        <div className="notice warn">
          <p>
            <strong>{config.model} isn't downloaded.</strong> In a terminal, run <code>{setup.command}</code>, then press
            “Check again”{setup.installed.length ? ", or pick one of your installed models above" : ""}.
          </p>
        </div>
      )}
    </div>
  );
}
