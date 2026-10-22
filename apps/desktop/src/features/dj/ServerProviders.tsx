import { useCallback, useEffect, useState } from "react";
import type { AdminLlmProvider, AdminLlmProviderInput, LlmStatusResponse } from "@uma/shared";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { useProviders } from "./providers";
import { EMPTY_FORM, ProviderForm, type ProviderFormValue } from "./ProviderForm";

const toForm = (p: AdminLlmProvider): ProviderFormValue => ({
  preset: "custom",
  name: p.name,
  kind: p.kind,
  baseUrl: p.baseUrl,
  model: p.model,
  apiKey: "",
  clearKey: false,
  share: false,
});

/** Admin only: providers the server calls itself. Their keys stay on the server. */
export function ServerProviders() {
  const api = useServer((s) => s.api);
  const refreshRemote = useProviders((s) => s.refreshRemote);
  const [items, setItems] = useState<AdminLlmProvider[]>([]);
  const [editing, setEditing] = useState<AdminLlmProvider | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: AdminLlmProvider[] }>("api/admin/llm/providers")).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = async () => {
    await load();
    await refreshRemote();
  };

  const input = (v: ProviderFormValue, extra: Partial<AdminLlmProviderInput> = {}): AdminLlmProviderInput => ({
    name: v.name.trim(),
    kind: v.kind,
    baseUrl: v.baseUrl.trim(),
    model: v.model.trim(),
    // Omitted keeps the saved key; "" removes it.
    ...(v.clearKey ? { apiKey: "" } : v.apiKey ? { apiKey: v.apiKey } : {}),
    ...extra,
  });

  async function save(v: ProviderFormValue) {
    if (editing === "new") {
      await api("api/admin/llm/providers", { method: "POST", body: JSON.stringify(input(v)) });
    } else if (editing) {
      await api(`api/admin/llm/providers/${editing.id}`, {
        method: "PUT",
        body: JSON.stringify(input(v, { enabled: editing.enabled, isDefault: editing.isDefault })),
      });
    }
    setEditing(null);
    await changed();
  }

  const test = (v: ProviderFormValue) =>
    api<LlmStatusResponse>("api/admin/llm/test", {
      method: "POST",
      body: JSON.stringify({ id: editing && editing !== "new" ? editing.id : undefined, kind: v.kind, baseUrl: v.baseUrl, model: v.model, apiKey: v.apiKey || undefined }),
    });

  async function update(p: AdminLlmProvider, patch: Partial<AdminLlmProviderInput>) {
    await api(`api/admin/llm/providers/${p.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled, isDefault: p.isDefault, ...patch }),
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    await changed();
  }

  return (
    <div className="stack">
      <h3 className="settings-subhead">Server providers</h3>
      <p className="muted small">
        These run on the server for everyone who signs in, so phones and browsers can use the DJ without any setup. API keys
        are stored encrypted on the server and are never sent to any app.
      </p>
      {error && <p className="notice error">{error}</p>}
      {items.length === 0 && editing !== "new" && <p className="muted small">No server providers yet.</p>}
      {items.map((p) =>
        editing && editing !== "new" && editing.id === p.id ? (
          <ProviderForm
            key={p.id}
            initial={toForm(p)}
            hasKey={p.hasKey}
            keyNote="Stored encrypted on the server. Never shown again."
            onSave={save}
            onTest={test}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div key={p.id} className="provider-row">
            <div className="provider-text">
              <strong>{p.name}</strong>
              {p.isDefault && <span className="badge">Default</span>}
              {!p.enabled && <span className="badge">Off</span>}
              <div className="muted small">
                {p.kind} · {p.model} · {p.baseUrl}
                {p.hasKey ? " · key saved" : ""}
              </div>
            </div>
            <div className="row">
              {!p.isDefault && p.enabled && (
                <button className="btn ghost" onClick={() => void update(p, { isDefault: true })}>
                  Make default
                </button>
              )}
              <button className="btn ghost" onClick={() => void update(p, { enabled: !p.enabled })}>
                {p.enabled ? "Turn off" : "Turn on"}
              </button>
              <button className="btn ghost" onClick={() => setEditing(p)}>
                Edit
              </button>
              <button
                className="btn ghost"
                onClick={() =>
                  void api(`api/admin/llm/providers/${p.id}`, { method: "DELETE" })
                    .then(changed)
                    .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                }
              >
                Remove
              </button>
            </div>
          </div>
        ),
      )}
      {editing === "new" ? (
        <ProviderForm
          initial={EMPTY_FORM}
          keyNote="Stored encrypted on the server. Never shown again."
          onSave={save}
          onTest={test}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div>
          <button className="btn ghost" onClick={() => setEditing("new")}>
            Add a server provider
          </button>
        </div>
      )}
    </div>
  );
}
