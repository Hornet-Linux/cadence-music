import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import type { Track } from "@/shared/types";
import { LikeButton } from "@/ui/CollectionButtons";
import { SearchIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";
import type { StreamingStore } from "./store";
import type { AdminConfigField, ServiceInfo, StreamPlaylist } from "./types";

/** "Powered by X" credit and a link to the service's own terms. Shown wherever its content is shown. */
export function Attribution({ info, extra }: { info: ServiceInfo; extra?: ReactNode }) {
  return (
    <p className="stream-credit muted small">
      <a href={info.credit.href} target="_blank" rel="noopener noreferrer">
        {info.credit.text}
      </a>
      {" · "}
      <a href={info.termsHref} target="_blank" rel="noopener noreferrer">
        {info.name} terms
      </a>
      {extra}
    </p>
  );
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="icon-btn stream-open" href={href} target="_blank" rel="noopener noreferrer" aria-label={label} data-tip="Open">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
    </a>
  );
}

/** What this plugin can and cannot do, in plain words. */
export function Capabilities({ info }: { info: ServiceInfo }) {
  return (
    <div className="stream-caps">
      <div>
        <div className="strong small">What works here</div>
        <ul className="stream-list small muted">
          {info.capabilities.works.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>
      <div>
        <div className="strong small">What doesn't, and why</div>
        <ul className="stream-list small muted">
          {info.capabilities.limits.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Field({ f, value, onChange }: { f: AdminConfigField; value: string; onChange: (v: string) => void }) {
  return (
    <label className="stream-field">
      <span className="field-label">
        {f.label}
        {f.optional ? " (optional)" : ""}
      </span>
      <input
        className="text-input"
        type={f.secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={f.secret && f.set ? "Saved. Leave blank to keep it." : (f.hint ?? "")}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

/** Server-owner form for the service's API credentials. Secrets are write-only. */
export function AdminConfigForm({ store, info }: { store: StreamingStore; info: ServiceInfo }) {
  const config = store((s) => s.adminConfig);
  const busy = store((s) => s.busy);
  const save = store((s) => s.saveAdminConfig);
  const load = store((s) => s.loadAdminConfig);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  if (!config) return <p className="muted small">Loading…</p>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const patch: Record<string, string | null> = {};
    for (const f of config.fields) {
      const v = (values[f.key] ?? (f.secret ? "" : (f.value ?? ""))).trim();
      if (f.secret) {
        if (v) patch[f.key] = v;
      } else patch[f.key] = v === "" ? null : v;
    }
    setSaved(await save(patch));
    setValues({});
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} aria-label={`${info.name} credentials`}>
      <p className="muted small">{info.adminHelp}</p>
      {config.redirectUri && (
        <div className="notice small">
          Register this redirect address with {info.name}:
          <code className="stream-uri selectable">{config.redirectUri}</code>
        </div>
      )}
      {config.fields.map((f) => (
        <Field key={f.key} f={f} value={values[f.key] ?? (f.secret ? "" : (f.value ?? ""))} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
      ))}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save credentials"}
        </button>
        {saved && <span className="muted small">Saved</span>}
      </div>
      <p className="muted small">Secrets are stored encrypted on your server and are never shown again.</p>
    </form>
  );
}

function useIsAdmin(): boolean {
  return useServer((s) => !!s.user?.isAdmin);
}

/** Why the service can't be used yet, or null when it can. */
function Gate({ store, info, onSettings }: { store: StreamingStore; info: ServiceInfo; onSettings?: () => void }) {
  const signedIn = useServer((s) => !!s.user);
  const status = store((s) => s.status);
  const missing = store((s) => s.missing);
  const checking = store((s) => s.checking);
  if (!signedIn) return <p className="notice">Sign in to your Cadence server first. {info.name} runs through it.</p>;
  if (missing) {
    return (
      <p className="notice warn">
        This server doesn't have the {info.name} add-on turned on. The server owner can enable <code>cadence.{info.slug}</code> under Settings, Plugins, then restart the server.
      </p>
    );
  }
  if (!status) return <p className="muted small">{checking ? "Checking…" : "Not checked yet."}</p>;
  if (!status.configured) {
    return (
      <p className="notice">
        {info.name} isn't set up on this server yet. The server owner needs to add API credentials in this panel.
        {onSettings && (
          <>
            {" "}
            <button className="btn ghost" onClick={onSettings}>
              Open settings
            </button>
          </>
        )}
      </p>
    );
  }
  return null;
}

/** Settings panel (also used as the first-run step). */
export function ServiceSettings({ store, info }: { store: StreamingStore; info: ServiceInfo }) {
  const admin = useIsAdmin();
  const signedIn = useServer((s) => !!s.user);
  const s = store();
  const status = s.status;

  useEffect(() => {
    if (signedIn) void store.getState().refresh();
  }, [signedIn, store]);

  const configured = !!status?.configured;

  return (
    <div className="stack stream-settings">
      {!configured && <Gate store={store} info={info} />}
      {configured && status && (
        <>
          {status.hasLogin ? (
            status.connected ? (
              <div className="signed-in">
                <div>
                  <div className="strong">{info.name}</div>
                  <div className="muted small">Connected{s.library.length ? ` · ${s.library.length} saved tracks` : ""}</div>
                </div>
                <div className="row">
                  <button className="btn ghost" disabled={s.libraryLoading} onClick={() => void s.loadLibrary()}>
                    Reload
                  </button>
                  <button className="btn ghost" disabled={s.busy} onClick={() => void s.disconnect()}>
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className="stack">
                <p className="muted small">Sign in with your {info.name} account to see your own library and playlists. Search works without this.</p>
                <div className="row">
                  <button className="btn primary" disabled={s.busy || s.waiting} onClick={() => void s.connect()}>
                    {s.waiting ? `Waiting for ${info.name}…` : `Connect ${info.name}`}
                  </button>
                  {s.waiting && (
                    <button className="btn ghost" onClick={s.cancelConnect}>
                      Cancel
                    </button>
                  )}
                </div>
                {s.waiting && s.signInUrl && (
                  <p className="muted small">
                    A browser window should have opened. If not,{" "}
                    <a href={s.signInUrl} target="_blank" rel="noopener noreferrer">
                      open the sign-in page
                    </a>
                    .
                  </p>
                )}
              </div>
            )
          ) : (
            <p className="muted small">{info.name} is ready. No personal sign-in is needed.</p>
          )}
        </>
      )}
      {s.error && <p className="notice error">{s.error}</p>}
      <Capabilities info={info} />
      {admin && signedIn && !s.missing && (
        <details className="stream-admin" open={!configured}>
          <summary>Server owner: {info.name} credentials</summary>
          <AdminConfigForm store={store} info={info} />
        </details>
      )}
      <Attribution info={info} />
    </div>
  );
}

/** The sidebar page: search, your library and playlists. */
export function ServicePage({ store, info, extra }: { store: StreamingStore; info: ServiceInfo; extra?: ReactNode }) {
  const openSettings = useSettingsModal((s) => s.show);
  const signedIn = useServer((s) => !!s.user);
  const status = store((s) => s.status);
  const links = store((s) => s.links);
  const library = store((s) => s.library);
  const loadingLibrary = store((s) => s.libraryLoading);
  const [tab, setTab] = useState<"search" | "library" | "playlists">("search");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Track[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<StreamPlaylist[] | null>(null);
  const [open, setOpen] = useState<{ name: string; tracks: Track[] } | null>(null);

  useEffect(() => {
    if (signedIn) void store.getState().refresh();
  }, [signedIn, store]);

  const usable = !!status?.configured;
  const canLibrary = usable && !!status?.features.library && !!status.connected;
  const wrap = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Request failed \(\d+\): ?/, "") : String(e));
      return null;
    }
  };

  const onSearch = async (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    setResults((await wrap(() => store.getState().search(term))) ?? []);
    setSearching(false);
  };

  const rowActions = (t: Track) => (
    <>
      <LikeButton track={t} />
      {links[t.id] && <ExternalLink href={links[t.id]!} label={`Open ${t.title} in ${info.name}`} />}
    </>
  );

  const list = (tracks: Track[]) => (
    <div className="track-list">
      {tracks.map((t, i) => (
        <TrackRow key={t.id} track={t} index={i} queue={tracks} likeAction={rowActions(t)} />
      ))}
    </div>
  );

  return (
    <div className="view stream-page">
      <header className="view-header">
        <h1>{info.name}</h1>
        <p className="muted">{status?.features.playback === "link" ? "Browse and open in the app." : "Search and play."}</p>
        <Attribution info={info} />
      </header>

      {!usable ? (
        <div className="card pad stack">
          <Gate store={store} info={info} onSettings={() => openSettings(info.slug)} />
          <div>
            <button className="btn primary" onClick={() => openSettings(info.slug)}>
              Open settings
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="stream-tabs">
            <div className="segmented" role="tablist" aria-label={`${info.name} sections`}>
              <button role="tab" aria-selected={tab === "search"} className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>
                Search
              </button>
              {status?.features.library && (
                <button role="tab" aria-selected={tab === "library"} className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>
                  Saved
                </button>
              )}
              {status?.features.playlists && (
                <button
                  role="tab"
                  aria-selected={tab === "playlists"}
                  className={tab === "playlists" ? "on" : ""}
                  onClick={() => {
                    setTab("playlists");
                    if (canLibrary && !playlists) void wrap(() => store.getState().playlists()).then((p) => setPlaylists(p ?? []));
                  }}
                >
                  Playlists
                </button>
              )}
            </div>
          </div>

          {error && <p className="notice error">{error}</p>}
          {extra}

          {tab === "search" && (
            <>
              <form className="search-bar stream-search" onSubmit={(e) => void onSearch(e)} role="search">
                <SearchIcon size={18} />
                <input placeholder={`Search ${info.name}`} aria-label={`Search ${info.name}`} value={q} onChange={(e) => setQ(e.target.value)} />
                <button className="btn" type="submit" disabled={searching || !q.trim()}>
                  {searching ? "…" : "Search"}
                </button>
              </form>
              <div className="stream-results">
                {results === null ? (
                  <p className="empty">Search {info.name} by song or artist.</p>
                ) : results.length === 0 ? (
                  <p className="empty">Nothing found.</p>
                ) : (
                  list(results)
                )}
              </div>
            </>
          )}

          {tab === "library" &&
            (!canLibrary ? (
              <div className="card pad stack">
                <p className="muted">Connect your {info.name} account to see your saved tracks.</p>
                <div>
                  <button className="btn primary" onClick={() => openSettings(info.slug)}>
                    Open settings
                  </button>
                </div>
              </div>
            ) : loadingLibrary && library.length === 0 ? (
              <p className="empty">Loading…</p>
            ) : library.length === 0 ? (
              <p className="empty">No saved tracks found.</p>
            ) : (
              list(library)
            ))}

          {tab === "playlists" &&
            (!canLibrary ? (
              <div className="card pad stack">
                <p className="muted">Connect your {info.name} account to see your playlists.</p>
                <div>
                  <button className="btn primary" onClick={() => openSettings(info.slug)}>
                    Open settings
                  </button>
                </div>
              </div>
            ) : open ? (
              <>
                <button className="btn ghost" onClick={() => setOpen(null)}>
                  Back to playlists
                </button>
                <h2 className="stream-subhead">{open.name}</h2>
                {open.tracks.length === 0 ? <p className="empty">This playlist has no playable tracks.</p> : list(open.tracks)}
              </>
            ) : playlists === null ? (
              <p className="empty">Loading…</p>
            ) : playlists.length === 0 ? (
              <p className="empty">No playlists found.</p>
            ) : (
              <ul className="stream-playlists">
                {playlists.map((p) => (
                  <li key={p.id}>
                    <button
                      className="stream-playlist"
                      onClick={() => void wrap(() => store.getState().playlistTracks(p.id)).then((tracks) => tracks && setOpen({ name: p.name, tracks }))}
                    >
                      <span className="strong">{p.name}</span>
                      {p.trackCount !== undefined && <span className="muted small">{p.trackCount} tracks</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}
    </div>
  );
}
