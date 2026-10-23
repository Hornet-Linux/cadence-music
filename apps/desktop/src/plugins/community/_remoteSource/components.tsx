import { useEffect, useState, type ReactNode } from "react";
import type { UseBoundStore, StoreApi } from "zustand";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { Toggle } from "@/features/settings/controls";
import { useServer } from "../../builtins/server/serverStore";
import { plainError, summarizeIndexing, toggleChoice, type FolderChoice, type RemoteStatus } from "./logic";
import type { RemoteSourceState } from "./store";
import "./style.css";

type Store<S extends RemoteStatus> = UseBoundStore<StoreApi<RemoteSourceState<S>>>;

/** Wraps a source's settings or page: handles "sign in to the server first", "not turned on" and loading. */
export function ServerGate<S extends RemoteStatus>({
  store,
  label,
  children,
}: {
  store: Store<S>;
  label: string;
  children: (status: S) => ReactNode;
}) {
  const user = useServer((s) => s.user);
  const openSettings = useSettingsModal((s) => s.show);
  const status = store((s) => s.status);
  const unavailable = store((s) => s.unavailable);
  const checking = store((s) => s.checking);
  const error = store((s) => s.error);
  const refresh = store((s) => s.refresh);

  if (!user) {
    return (
      <div className="stack rs-root">
        <p className="muted small">
          {label} connects through your Cadence server, so sign in to the server first. The server keeps the login and reads the files; this
          device never sees them.
        </p>
        <div>
          <button className="btn" onClick={() => openSettings("server")}>
            Open server settings
          </button>
        </div>
      </div>
    );
  }
  if (unavailable) {
    return (
      <div className="stack rs-root">
        <p className="notice">
          {label} isn&apos;t turned on at your server. The server owner turns it on in the server's admin page under Plugins, then restarts the server.
        </p>
        <div>
          <button className="btn ghost" onClick={() => void refresh()}>
            Check again
          </button>
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="stack rs-root">
        <p className="muted small">{checking ? `Checking ${label}…` : `Couldn't check ${label}.`}</p>
        {error && <p className="notice error">{error}</p>}
        {!checking && (
          <div>
            <button className="btn ghost" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }
  return <div className="stack rs-root">{children(status)}</div>;
}

/** One line about the indexer, with a notice if something needs attention and a button to refresh now. */
export function IndexLine<S extends RemoteStatus>({ store }: { store: Store<S> }) {
  const status = store((s) => s.status);
  const startIndex = store((s) => s.startIndex);
  if (!status) return null;
  const sum = summarizeIndexing(status.trackCount, status.indexing);
  return (
    <div className="stack">
      <div className="rs-index">
        <span className={`rs-dot${sum.busy ? " busy" : ""}`} aria-hidden />
        <span className="small" role="status">
          {sum.text}
        </span>
        <button className="btn ghost" onClick={() => void startIndex()} disabled={sum.busy}>
          {sum.busy ? "Indexing…" : "Refresh now"}
        </button>
      </div>
      {sum.problem && (
        <p className="notice warn" role="alert">
          {sum.problem}
        </p>
      )}
    </div>
  );
}

export interface FolderLevel {
  /** Where we are, as the server describes it. */
  here: FolderChoice;
  folders: FolderChoice[];
}

/**
 * Pick the folders to index. Opens a level at a time; each folder has a checkbox to include it. With nothing
 * picked the whole share is indexed.
 */
export function FolderPicker({
  rootName,
  initial,
  load,
  save,
  hint,
}: {
  rootName: string;
  initial: FolderChoice[];
  /** Folders inside `parent` (null at the top). */
  load: (parent: FolderChoice | null) => Promise<FolderChoice[]>;
  save: (choices: FolderChoice[]) => Promise<void>;
  hint?: string;
}) {
  const [trail, setTrail] = useState<FolderChoice[]>([]);
  const [folders, setFolders] = useState<FolderChoice[] | null>(null);
  const [picked, setPicked] = useState<FolderChoice[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const here = trail.length ? trail[trail.length - 1]! : null;

  useEffect(() => {
    let live = true;
    setFolders(null);
    setError(null);
    load(here)
      .then((f) => live && setFolders(f))
      .catch((e: unknown) => live && setError(plainError(e)));
    return () => {
      live = false;
    };
    // `load` is stable per source; the level changes with the trail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here?.key]);

  const dirty = picked.map((p) => p.key).sort().join("\n") !== initial.map((p) => p.key).sort().join("\n");

  return (
    <div className="stack rs-folders">
      {hint && <p className="muted small">{hint}</p>}
      <nav className="rs-crumbs" aria-label="Folder path">
        <button className="rs-crumb" onClick={() => setTrail([])} disabled={!here}>
          {rootName}
        </button>
        {trail.map((t, i) => (
          <span key={t.key} className="rs-crumb-wrap">
            <span aria-hidden className="rs-sep">
              /
            </span>
            <button className="rs-crumb" onClick={() => setTrail(trail.slice(0, i + 1))} disabled={i === trail.length - 1}>
              {t.name}
            </button>
          </span>
        ))}
      </nav>
      {error && <p className="notice error">{error}</p>}
      {folders === null && !error && <p className="muted small">Loading folders…</p>}
      {folders && folders.length === 0 && <p className="muted small">No folders in here.</p>}
      <ul className="rs-folder-list">
        {folders?.map((f) => {
          const on = picked.some((p) => p.key === f.key);
          return (
            <li key={f.key} className="rs-folder">
              <label className="rs-check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    setSaved(false);
                    setPicked(toggleChoice(picked, f));
                  }}
                  aria-label={`Index ${f.name}`}
                />
              </label>
              <button className="rs-folder-open" onClick={() => setTrail([...trail, f])} aria-label={`Open ${f.name}`}>
                <span className="rs-folder-name">{f.name}</span>
                <span aria-hidden className="muted">
                  ›
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="rs-picked">
        <div className="small strong">{picked.length === 0 ? "Indexing everything" : `Indexing ${picked.length} ${picked.length === 1 ? "folder" : "folders"}`}</div>
        {picked.length > 0 && (
          <ul className="rs-chips">
            {picked.map((p) => (
              <li key={p.key}>
                <button
                  className="rs-chip"
                  onClick={() => {
                    setSaved(false);
                    setPicked(toggleChoice(picked, p));
                  }}
                  aria-label={`Stop indexing ${p.name}`}
                >
                  {p.name} <span aria-hidden>×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="row">
        <button
          className="btn primary"
          disabled={!dirty || saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            save(picked)
              .then(() => setSaved(true))
              .catch((e: unknown) => setError(plainError(e)))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Save folders"}
        </button>
        {saved && !dirty && <span className="muted small">Saved. Indexing again.</span>}
      </div>
    </div>
  );
}

/** For the server owner: may people connect to servers on this network (a NAS, MinIO at home)? */
export function NetworkSwitch<S extends RemoteStatus>({ store }: { store: Store<S> }) {
  const isAdmin = useServer((s) => !!s.user?.isAdmin);
  const call = store((s) => s.call);
  const [state, setState] = useState<{ allowPrivateNetwork: boolean; source: "env" | "admin" | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    call<{ allowPrivateNetwork: boolean; source: "env" | "admin" | null }>("admin")
      .then((s) => live && setState(s))
      .catch((e: unknown) => live && setError(plainError(e)));
    return () => {
      live = false;
    };
  }, [isAdmin, call]);

  if (!isAdmin) return null;
  const locked = state?.source === "env";
  return (
    <details className="rs-admin">
      <summary>Server owner options</summary>
      <div className="stack">
        <div className="rs-switch-row">
          <div>
            <div className="strong">Allow servers on this network</div>
            <div className="muted small">
              Needed when your files live on a NAS or computer at home. Off by default, so people can only connect to servers on the
              internet.{locked ? " Set by SOURCES_ALLOW_PRIVATE_NETWORK in the server settings." : ""}
            </div>
          </div>
          <Toggle
            label="Allow servers on this network"
            on={!!state?.allowPrivateNetwork}
            onChange={(on) => {
              if (!state || locked) return;
              setError(null);
              call<{ allowPrivateNetwork: boolean; source: "env" | "admin" | null }>("admin", { method: "PUT", body: JSON.stringify({ allowPrivateNetwork: on }) })
                .then(setState)
                .catch((e: unknown) => setError(plainError(e)));
            }}
          />
        </div>
        {error && <p className="notice error">{error}</p>}
      </div>
    </details>
  );
}

/** Label + input pair that keeps tap targets large. */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
  help,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  help?: string;
  readOnly?: boolean;
}) {
  return (
    <label className="rs-field">
      <span className="field-label">{label}</span>
      <input
        className="text-input"
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete ?? "off"}
        spellCheck={false}
        autoCapitalize="off"
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
      {help && <span className="muted small">{help}</span>}
    </label>
  );
}
