import { useState } from "react";
import type { Plugin } from "../../types";
import { ClockIcon } from "@/ui/icons";
import { Check, Field, Notice, NeedServer, OpsPage, Section, downloadFile, formatBytes, formatWhen, useAction, useLoad, useOps } from "../_ops/ui";
import "./style.css";

interface PlaylistInfo {
  id: string;
  name: string;
  trackCount: number;
}

interface Snapshot {
  name: string;
  kind: "manual" | "auto";
  size: number;
  createdAt: number;
}

interface BackupOverview {
  config: { enabled: boolean; everyHours: number; keep: number };
  snapshots: Snapshot[];
  folder: string;
  databaseSize: number;
  lastError: string | null;
  restore: string;
}

type PlaylistFormat = "m3u" | "xspf" | "json";

const FORMAT_LABEL: Record<PlaylistFormat, string> = { m3u: "M3U", xspf: "XSPF", json: "JSON" };

function PlaylistExport() {
  const { api } = useOps();
  const list = useLoad(() => api<{ items: PlaylistInfo[] }>("api/export/playlists"));
  const { busy, error, run, setError } = useAction();
  const [format, setFormat] = useState<PlaylistFormat>("m3u");

  const get = (route: string, name: string) => run(() => downloadFile(route, name));

  return (
    <Section title="Your playlists" hint="Playlists saved to your server. M3U works in most players, XSPF keeps album and length, JSON keeps everything.">
      {list.loading && <p className="muted">Loading your playlists...</p>}
      {list.error && <Notice tone="error">{list.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {list.data && list.data.items.length === 0 && <p className="muted">You have no playlists on the server yet. Make one and it shows up here.</p>}
      {list.data && list.data.items.length > 0 && (
        <>
          <div className="ops-actions">
            <Field label="Format" htmlFor="pl-format">
              <select id="pl-format" value={format} onChange={(e) => setFormat(e.target.value as PlaylistFormat)}>
                {(Object.keys(FORMAT_LABEL) as PlaylistFormat[]).map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABEL[f]}
                  </option>
                ))}
              </select>
            </Field>
            <button className="btn backup-all" disabled={busy} onClick={() => void get(`api/export/playlists.zip?format=${format}`, "cadence-playlists.zip")}>
              Download all as ZIP
            </button>
          </div>
          <div className="ops-list">
            {list.data.items.map((p) => (
              <div className="ops-item" key={p.id}>
                <div className="ops-item-text">
                  <div className="ops-item-title">{p.name}</div>
                  <div className="ops-item-sub">{p.trackCount} track{p.trackCount === 1 ? "" : "s"}</div>
                </div>
                <div className="ops-item-buttons">
                  <button className="btn" disabled={busy} onClick={() => void get(`api/export/playlists/${encodeURIComponent(p.id)}?format=${format}`, `${p.name}.${format}`)}>
                    Download {FORMAT_LABEL[format]}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {list.error && (
        <div>
          <button className="btn" onClick={() => { setError(null); list.reload(); }}>
            Try again
          </button>
        </div>
      )}
    </Section>
  );
}

function HistoryExport() {
  const { busy, error, run } = useAction();
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const download = () => {
    const params = new URLSearchParams({ format });
    if (from) params.set("since", String(new Date(`${from}T00:00:00`).getTime()));
    if (to) params.set("until", String(new Date(`${to}T23:59:59`).getTime()));
    return run(() => downloadFile(`api/export/history?${params}`, `cadence-history.${format}`));
  };

  return (
    <Section title="Listening history" hint="Every play your server has recorded for you, newest first. CSV opens in a spreadsheet; JSON suits scripts.">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="ops-grid">
        <Field label="Format" htmlFor="hist-format">
          <select id="hist-format" value={format} onChange={(e) => setFormat(e.target.value as "csv" | "json")}>
            <option value="csv">CSV (spreadsheet)</option>
            <option value="json">JSON</option>
          </select>
        </Field>
        <Field label="From (optional)" htmlFor="hist-from">
          <input id="hist-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Until (optional)" htmlFor="hist-to">
          <input id="hist-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <div>
        <button className="btn" disabled={busy} onClick={() => void download()}>
          Download history
        </button>
      </div>
    </Section>
  );
}

function ServerBackup() {
  const { api } = useOps();
  const overview = useLoad(() => api<BackupOverview>("api/backup"));
  const { busy, error, run } = useAction();
  const [cfg, setCfg] = useState<BackupOverview["config"] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const config = cfg ?? overview.data?.config ?? null;

  const snapshot = async () => {
    setNote(null);
    const done = await run(() => api<{ snapshot: Snapshot; check: { integrity: string; users: number; tracks: number } }>("api/backup/snapshot", { method: "POST" }));
    if (done) {
      setNote(`Snapshot saved and checked (database integrity: ${done.check.integrity}).`);
      overview.reload();
    }
  };
  const remove = async (s: Snapshot) => {
    if (!window.confirm(`Delete ${s.name}?`)) return;
    await run(() => api<void>(`api/backup/snapshots/${encodeURIComponent(s.name)}`, { method: "DELETE" }));
    overview.reload();
  };
  const saveConfig = async () => {
    if (!config) return;
    const saved = await run(() => api<{ config: BackupOverview["config"] }>("api/backup/config", { method: "PUT", body: JSON.stringify(config) }));
    if (saved) {
      setCfg(saved.config);
      setNote("Schedule saved.");
    }
  };

  return (
    <Section title="Server backup (admin)" hint="A snapshot is a consistent copy of the whole database: accounts, playlists, history and settings. It does not include your music files.">
      {overview.error && <Notice tone="error">{overview.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice tone="ok">{note}</Notice>}
      {overview.data?.lastError && <Notice tone="error">The last scheduled snapshot failed: {overview.data.lastError}</Notice>}
      {overview.data && (
        <>
          <div className="ops-actions">
            <button className="btn" disabled={busy} onClick={() => void snapshot()}>
              Create snapshot now
            </button>
            <span className="muted small">Database size {formatBytes(overview.data.databaseSize)}. Snapshots live in {overview.data.folder} on the server.</span>
          </div>

          <div className="ops-list">
            {overview.data.snapshots.length === 0 && <p className="muted">No snapshots yet.</p>}
            {overview.data.snapshots.map((s) => (
              <div className="ops-item" key={s.name}>
                <div className="ops-item-text">
                  <div className="ops-item-title">{formatWhen(s.createdAt)}</div>
                  <div className="ops-item-sub">
                    {s.kind === "auto" ? "Scheduled" : "Manual"} - {formatBytes(s.size)} - {s.name}
                  </div>
                </div>
                <div className="ops-item-buttons">
                  <button className="btn" disabled={busy} onClick={() => void run(() => downloadFile(`api/backup/download/${encodeURIComponent(s.name)}`, s.name))}>
                    Download
                  </button>
                  <button className="btn ghost" disabled={busy} onClick={() => void remove(s)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          {config && (
            <div className="ops-stack backup-schedule">
              <h3 className="backup-sub">Schedule</h3>
              <Check checked={config.enabled} onChange={(enabled) => setCfg({ ...config, enabled })}>
                Take a snapshot automatically
              </Check>
              <div className="ops-grid">
                <Field label="Every (hours)" htmlFor="bk-every">
                  <input id="bk-every" type="number" min={1} max={720} value={config.everyHours} onChange={(e) => setCfg({ ...config, everyHours: Number(e.target.value) })} />
                </Field>
                <Field label="Scheduled snapshots to keep" hint="Older scheduled ones are deleted. Manual snapshots are never deleted automatically." htmlFor="bk-keep">
                  <input id="bk-keep" type="number" min={1} max={60} value={config.keep} onChange={(e) => setCfg({ ...config, keep: Number(e.target.value) })} />
                </Field>
              </div>
              <div>
                <button className="btn" disabled={busy} onClick={() => void saveConfig()}>
                  Save schedule
                </button>
              </div>
            </div>
          )}

          <details>
            <summary>How to restore a snapshot</summary>
            <pre>{overview.data.restore}</pre>
          </details>
          <Notice tone="warn">A snapshot contains password hashes and sign-in sessions. Keep downloaded copies somewhere private. There is deliberately no restore button in the app.</Notice>
        </>
      )}
    </Section>
  );
}

function BackupPage() {
  const { isAdmin } = useOps();
  return (
    <OpsPage title="Backup and export" subtitle="Take your playlists and listening history with you, and keep a copy of your server's data.">
      <NeedServer>
        <PlaylistExport />
        <HistoryExport />
        {isAdmin && <ServerBackup />}
      </NeedServer>
    </OpsPage>
  );
}

const plugin: Plugin = {
  manifest: {
    id: "cadence.backup-export",
    name: "Backup and export",
    version: "1.0.0",
    description: "Download your playlists (M3U, XSPF, JSON) and listening history (CSV, JSON). Admins can also snapshot and download the server database.",
    author: "Cadence",
    capabilities: ["ui.sidebar"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: "backup-export", label: "Backup", icon: <ClockIcon />, render: () => <BackupPage /> });
  },
};

export default plugin;