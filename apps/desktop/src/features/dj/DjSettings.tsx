import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmStatus } from "../../../electron/llm";
import { Segmented, SettingRow, Toggle } from "@/features/settings/controls";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { useDj } from "./djStore";
import { EMPTY_FORM, ProviderForm, type ProviderFormValue } from "./ProviderForm";
import {
  effectiveOption,
  getApiKey,
  keyStorageNote,
  providerOptions,
  providerStatus,
  useProviders,
  type LocalProvider,
  type ProviderOption,
} from "./providers";
import { deviceName, useRelay } from "./relayClient";
import { latestOnly } from "./latest";
import { ServerProviders } from "./ServerProviders";
import { djSetup, OLLAMA_DOWNLOAD_URL } from "./setup";

const toForm = (p: LocalProvider): ProviderFormValue => ({
  ...EMPTY_FORM,
  preset: "custom",
  name: p.name,
  kind: p.kind,
  baseUrl: p.baseUrl,
  model: p.model,
  share: p.share,
  clearKey: false,
});

/** Settings → AI DJ: where the model runs, and spoken intros. */
export function DjSettings() {
  const KEY_NOTE = keyStorageNote();
  const { voice, setVoice, sourcePref, setSourcePref } = useDj();
  const { local, remote, native, selected, select, addLocal, updateLocal, removeLocal, refreshRemote } = useProviders();
  const server = useServer((s) => s.user);
  const relay = useRelay();
  const [editing, setEditing] = useState<LocalProvider | "new" | null>(null);
  const [editingHasKey, setEditingHasKey] = useState(false);

  useEffect(() => {
    void refreshRemote();
  }, [refreshRemote, server]);

  const options = providerOptions(local, remote, native);
  const active = effectiveOption(selected, options);

  async function saveLocal(v: ProviderFormValue) {
    const fields = { name: v.name.trim(), kind: v.kind, baseUrl: v.baseUrl.trim(), model: v.model.trim(), share: v.share && !!server };
    if (editing && editing !== "new") {
      await updateLocal(editing.id, fields, v.clearKey ? null : v.apiKey || undefined);
    } else {
      const id = await addLocal(fields, v.apiKey || undefined);
      select(`local:${id}`);
    }
    setEditing(null);
  }

  async function testLocal(v: ProviderFormValue): Promise<LlmStatus> {
    const llm = window.host?.llm;
    if (!llm) return { available: false, models: [], error: "Not available in this build" };
    const apiKey = v.apiKey || (editing && editing !== "new" && !v.clearKey ? await getApiKey(editing.id) : undefined);
    return llm.status({ kind: v.kind, baseUrl: v.baseUrl.trim(), model: v.model.trim(), ...(apiKey ? { apiKey } : {}) });
  }

  async function edit(p: LocalProvider) {
    setEditingHasKey(!!(await getApiKey(p.id)));
    setEditing(p);
  }

  return (
    <div className="stack">
      <SettingRow
        title="DJ plays from"
        description="Where the DJ learns your taste and finds songs. Auto uses Jellyfin when it's connected, otherwise Spotify."
      >
        <Segmented
          label="DJ plays from"
          value={sourcePref}
          onChange={setSourcePref}
          options={[
            { value: "auto", label: "Auto" },
            { value: "spotify", label: "Spotify" },
            { value: "jellyfin", label: "Jellyfin" },
          ]}
        />
      </SettingRow>
      <SettingRow title="Spoken intros" description="The DJ talks over the start of each song, with the music turned down.">
        <Toggle on={voice} onChange={setVoice} label="Spoken intros" />
      </SettingRow>

      <h3 className="settings-subhead">AI provider</h3>
      <p className="muted small">
        Where the DJ's model runs. Providers on the server work on every device. Providers on this device keep their keys here
        {server ? ", and can be shared with your other devices through the server" : ""}.
      </p>

      <div className="provider-list" role="radiogroup" aria-label="AI provider">
        {options.length === 0 && <p className="muted small">No providers yet. Add one below.</p>}
        {options.map((o) => {
          const mine = o.scope === "local" ? local.find((p) => `local:${p.id}` === o.ref) : undefined;
          if (mine && editing && editing !== "new" && editing.id === mine.id) {
            return (
              <ProviderForm
                key={o.ref}
                initial={toForm(mine)}
                hasKey={editingHasKey}
                canShare={!!server}
                keyNote={KEY_NOTE}
                onSave={saveLocal}
                onTest={testLocal}
                onCancel={() => setEditing(null)}
              />
            );
          }
          return (
            <div key={o.ref} className={`provider-row${active?.ref === o.ref ? " on" : ""}`}>
              <label className="provider-text">
                <input type="radio" name="dj-provider" checked={active?.ref === o.ref} onChange={() => select(o.ref)} />
                <strong>{o.name}</strong>
                <span className="badge">{o.where}</span>
                {mine?.share && <span className="badge">Shared</span>}
                {o.isDefault && <span className="badge">Server default</span>}
                <div className="muted small">
                  {o.kind} · {o.model}
                </div>
              </label>
              {mine && (
                <div className="row">
                  <button className="btn ghost" onClick={() => void edit(mine)}>
                    Edit
                  </button>
                  <button className="btn ghost" onClick={() => void removeLocal(mine.id)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editing === "new" ? (
        <ProviderForm
          canShare={!!server}
          keyNote={KEY_NOTE}
          onSave={saveLocal}
          onTest={testLocal}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div>
          <button className="btn ghost" onClick={() => setEditing("new")}>
            Add a provider on this device
          </button>
        </div>
      )}

      {active && <ProviderHealth option={active} />}
      {server?.isAdmin && <ServerProviders />}
      {server && local.some((p) => p.share) && relay.message && <p className="notice warn">{relay.message}</p>}
      {server && local.some((p) => p.share) && !relay.message && (
        <p className="muted small">
          {relay.state === "connected"
            ? `Sharing as “${deviceName()}” while this app is open.`
            : relay.state === "off"
              ? ""
              : "Connecting to your server to share…"}
        </p>
      )}
    </div>
  );
}

/** Is the chosen provider reachable? Explains what to do when it isn't. */
function ProviderHealth({ option }: { option: ProviderOption }) {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const web = window.host?.platform === ("web" as string);
  // A slow check for the previous provider must not overwrite the answer for this one.
  const latest = useRef(latestOnly());

  const check = useCallback(async () => {
    const current = latest.current.begin();
    setChecking(true);
    try {
      const result = await providerStatus(option.ref);
      if (current()) setStatus(result);
    } catch (e) {
      if (current()) setStatus({ available: false, models: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (current()) setChecking(false);
    }
  }, [option.ref]);

  useEffect(() => {
    const checks = latest.current;
    setStatus(null);
    void check();
    return () => checks.cancel();
  }, [check, option.model]);

  const setup = status ? djSetup(option, status) : null;
  return (
    <div className="stack">
      <div className="row">
        <button className="btn ghost" disabled={checking} onClick={() => void check()}>
          {checking ? "Checking…" : "Check again"}
        </button>
        {setup?.kind === "ready" && <span className="muted small">{option.name} is ready ({option.model}).</span>}
      </div>

      {setup?.kind === "no-ollama" && (
        <div className="notice warn">
          <p>
            <strong>Ollama isn't running.</strong> It picks songs on your own computer, so nothing about your listening leaves
            it.
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
              In a terminal, run <code>ollama pull {option.model}</code>.
            </li>
            {web && (
              <li>
                Allow this site to reach Ollama by setting <code>OLLAMA_ORIGINS={location.origin}</code> and restarting it.
              </li>
            )}
            <li>Press “Check again”.</li>
          </ol>
          {setup.detail && <p className="muted small">Details: {setup.detail}</p>}
        </div>
      )}

      {setup?.kind === "unreachable" && (
        <div className="notice warn">
          <p>
            <strong>{option.name} can't be reached.</strong> Check the address and API key
            {option.scope === "device" ? ", and that the app on that computer is open" : ""}.
          </p>
          {setup.detail && <p className="muted small">Details: {setup.detail}</p>}
        </div>
      )}

      {setup?.kind === "no-model" && (
        <div className="notice warn">
          <p>
            <strong>{setup.model} isn't available.</strong>{" "}
            {setup.command ? (
              <>
                In a terminal, run <code>{setup.command}</code>, then press “Check again”.
              </>
            ) : (
              "Edit the provider and pick one of its models."
            )}
          </p>
        </div>
      )}
    </div>
  );
}
