import { useEffect, useState } from "react";
import { useServer } from "../../builtins/server/serverStore";
import { Field, FolderPicker, IndexLine, ServerGate } from "../_remoteSource/components";
import { plainError } from "../_remoteSource/logic";
import { stores, type AppsView, type CloudProviderId, type CloudStatus } from "./cloud";

const CONNECT_WAIT_MS = 5 * 60_000;
const CONNECT_POLL_MS = 3000;

const DOCS = "https://github.com/Hornet-Linux/cadence-music/blob/main/docs/CLOUD_SOURCES.md";

function Provider({ id, label, status }: { id: CloudProviderId; label: string; status: CloudStatus }) {
  const store = stores[id];
  const call = store((s) => s.call);
  const refresh = store((s) => s.refresh);
  const disconnect = store((s) => s.disconnect);
  const busy = store((s) => s.busy);
  const error = store((s) => s.error);
  const [waiting, setWaiting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  // After the browser tab opens, keep checking until the server reports the sign-in (or give up).
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const t = setInterval(() => {
      void refresh();
      if (Date.now() - started > CONNECT_WAIT_MS) setWaiting(false);
    }, CONNECT_POLL_MS);
    return () => clearInterval(t);
  }, [waiting, refresh]);
  useEffect(() => {
    if (status.connected && waiting) setWaiting(false);
  }, [status.connected, waiting]);

  async function start() {
    setLocalError(null);
    try {
      const { url } = await call<{ url: string }>("authorize", { method: "POST" });
      window.open(url, "_blank", "noopener");
      setWaiting(true);
    } catch (e) {
      setLocalError(plainError(e));
    }
  }

  const shown = localError ?? error;
  return (
    <section className="stack rs-provider" aria-label={label}>
      <h3 className="strong">{label}</h3>
      {!status.configured ? (
        <p className="notice">
          {label} isn&apos;t set up on this server yet. The server owner registers an app with {label} and enters it under Server owner setup below (
          <a href={DOCS} target="_blank" rel="noreferrer">
            how
          </a>
          ).
        </p>
      ) : status.connected ? (
        <>
          <dl className="rs-facts">
            <dt>Account</dt>
            <dd>{status.account ?? "Connected"}</dd>
            <dt>Folders</dt>
            <dd>{status.folders.length === 0 ? "Everything" : status.folders.map((f) => f.name).join(", ")}</dd>
          </dl>
          <IndexLine store={store} />
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setChoosing(!choosing)} aria-expanded={choosing}>
              {choosing ? "Hide folders" : "Choose folders"}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
          {choosing && (
            <FolderPicker
              rootName={label}
              initial={status.folders.map((f) => ({ key: f.id, name: f.name }))}
              hint="Tick the folders that hold your music. With none ticked, your whole drive is searched for audio files, which can take a while."
              load={async (parent) => {
                const res = await call<{ folders: { id: string; name: string }[] }>(`folders${parent ? `?parent=${encodeURIComponent(parent.key)}` : ""}`);
                return res.folders.map((f) => ({ key: f.id, name: f.name }));
              }}
              save={async (choices) => {
                await call("folders", { method: "PUT", body: JSON.stringify({ folders: choices.map((c) => ({ id: c.key, name: c.name })) }) });
                await refresh();
              }}
            />
          )}
        </>
      ) : (
        <>
          {status.needsReconnect && (
            <p className="notice warn" role="alert">
              Your {label} sign-in expired or was removed. Connect again to keep playing. Your indexed tracks are kept meanwhile.
            </p>
          )}
          <p className="muted small">
            You sign in on {label}&apos;s own page. Cadence only asks to read your files, never to change them, and your password never reaches Cadence.
          </p>
          {!status.publicUrlSet && <p className="notice warn">The server owner needs to set PUBLIC_URL before {label} sign-in can work.</p>}
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button className="btn primary" onClick={() => void start()} disabled={waiting || !status.publicUrlSet}>
              {waiting ? "Waiting for sign-in…" : status.needsReconnect ? `Connect ${label} again` : `Connect ${label}`}
            </button>
            {waiting && (
              <button className="btn ghost" onClick={() => setWaiting(false)}>
                Cancel
              </button>
            )}
          </div>
          {waiting && <p className="muted small">Finish signing in in the tab that opened, then come back here.</p>}
        </>
      )}
      {shown && (
        <p className="notice error" role="alert">
          {shown}
        </p>
      )}
    </section>
  );
}

/** Server owner: enter the OAuth apps registered with Google and Microsoft. */
function OwnerSetup() {
  const isAdmin = useServer((s) => !!s.user?.isAdmin);
  const api = useServer((s) => s.api);
  const [view, setView] = useState<AppsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState({ google: { clientId: "", clientSecret: "" }, microsoft: { clientId: "", clientSecret: "", tenant: "" } });

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    api<AppsView>("api/onedrive-gdrive/apps")
      .then((v) => {
        if (!live) return;
        setView(v);
        setForm((f) => ({ google: { ...f.google, clientId: v.google.clientId ?? "" }, microsoft: { ...f.microsoft, clientId: v.microsoft.clientId ?? "", tenant: v.microsoft.tenant ?? "" } }));
      })
      .catch((e: unknown) => live && setError(plainError(e)));
    return () => {
      live = false;
    };
  }, [isAdmin, api]);

  if (!isAdmin) return null;

  async function save(provider: CloudProviderId) {
    setError(null);
    setNote(null);
    const f = form[provider];
    try {
      const next = await api<AppsView>("api/onedrive-gdrive/apps", {
        method: "PUT",
        body: JSON.stringify({ provider, clientId: f.clientId.trim(), clientSecret: f.clientSecret.trim() || undefined, ...(provider === "microsoft" ? { tenant: form.microsoft.tenant.trim() || undefined } : {}) }),
      });
      setView(next);
      setForm((cur) => ({ ...cur, [provider]: { ...cur[provider], clientSecret: "" } }));
      setNote("Saved.");
      void stores.google.getState().refresh();
      void stores.microsoft.getState().refresh();
    } catch (e) {
      setError(plainError(e));
    }
  }

  return (
    <details className="rs-admin">
      <summary>Server owner setup</summary>
      <div className="stack">
        <p className="muted small">
          Register a free app with Google and/or Microsoft, then enter its client ID and secret here. Cadence only requests read access to files.{" "}
          <a href={DOCS} target="_blank" rel="noreferrer">
            Step-by-step guide
          </a>
          .
        </p>
        <Field label="Redirect address to give them" value={view?.redirectUri ?? "Set PUBLIC_URL on the server first"} onChange={() => undefined} readOnly help="Copy this exactly into the app's redirect or callback setting." />
        <div className="rs-form">
          <h4 className="strong">Google Drive {view?.google.configured ? "(set up)" : ""}</h4>
          <Field label="Client ID" value={form.google.clientId} onChange={(v) => setForm({ ...form, google: { ...form.google, clientId: v } })} />
          <Field label="Client secret" type="password" autoComplete="new-password" value={form.google.clientSecret} onChange={(v) => setForm({ ...form, google: { ...form.google, clientSecret: v } })} help={view?.google.configured ? "Leave empty to keep the saved secret." : undefined} />
          <div>
            <button className="btn" onClick={() => void save("google")} disabled={!form.google.clientId.trim()}>
              Save Google app
            </button>
          </div>
        </div>
        <div className="rs-form">
          <h4 className="strong">OneDrive {view?.microsoft.configured ? "(set up)" : ""}</h4>
          <Field label="Application (client) ID" value={form.microsoft.clientId} onChange={(v) => setForm({ ...form, microsoft: { ...form.microsoft, clientId: v } })} />
          <Field label="Client secret value" type="password" autoComplete="new-password" value={form.microsoft.clientSecret} onChange={(v) => setForm({ ...form, microsoft: { ...form.microsoft, clientSecret: v } })} help={view?.microsoft.configured ? "Leave empty to keep the saved secret." : undefined} />
          <Field label="Tenant (optional)" value={form.microsoft.tenant} onChange={(v) => setForm({ ...form, microsoft: { ...form.microsoft, tenant: v } })} placeholder="common" help="common works for personal and work accounts. Use consumers for personal accounts only." />
          <div>
            <button className="btn" onClick={() => void save("microsoft")} disabled={!form.microsoft.clientId.trim()}>
              Save OneDrive app
            </button>
          </div>
        </div>
        {note && <p className="muted small">{note}</p>}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

/** Sign in to Google Drive and OneDrive (read-only) through your Cadence server. Untested against the real services. */
export function CloudSettings() {
  return (
    <>
      <ServerGate store={stores.google} label="Google Drive and OneDrive">
        {(google) => (
          <>
            <p className="notice">
              Experimental: this connection was built from the official documentation and has only been tested against imitations of Google and Microsoft, not the real services.
            </p>
            <Provider id="google" label="Google Drive" status={google} />
            <OneDriveCard />
          </>
        )}
      </ServerGate>
      <div className="rs-root" style={{ marginTop: 16 }}>
        <OwnerSetup />
      </div>
    </>
  );
}

function OneDriveCard() {
  const status = stores.microsoft((s) => s.status);
  if (!status) return null;
  return <Provider id="microsoft" label="OneDrive" status={status} />;
}
