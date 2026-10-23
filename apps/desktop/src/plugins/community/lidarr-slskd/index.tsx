import { useEffect, useState } from "react";
import type { Plugin } from "../../types";
import { DiscIcon } from "@/ui/icons";
import { Check, Field, NeedAdmin, Notice, formatWhen, useAction, useLoad, useOps } from "../_ops/ui";
import "./style.css";

interface Config {
  notice: string;
  noticeVersion: number;
  acknowledged: { by: string; at: number } | null;
  lidarr: { url: string; apiKeySet: boolean; rootFolderPath: string | null } | null;
  slskd: { url: string; apiKeySet: boolean } | null;
}

interface AlbumHit {
  foreignAlbumId: string;
  title: string;
  artist: string;
  releaseDate: string | null;
  albumType: string | null;
  inLibrary: boolean;
  monitored: boolean;
}

interface LidarrStatus {
  version: string | null;
  missing: number;
  queue: { title: string; artist: string | null; status: string; progress: number; timeLeft: string | null; errorMessage: string | null }[];
}

interface SlskdResult {
  state: string;
  isComplete: boolean;
  responseCount: number;
  fileCount: number;
  responses: { username: string; freeUploadSlots: boolean; fileCount: number; files: { filename: string; size: number; bitRate: number | null; extension: string }[] }[];
}

function Settings({ config, onSaved }: { config: Config; onSaved: () => void }) {
  const { api } = useOps();
  const { busy, error, run } = useAction();
  const [accepted, setAccepted] = useState(Boolean(config.acknowledged));
  const [lUrl, setLUrl] = useState(config.lidarr?.url ?? "");
  const [lKey, setLKey] = useState("");
  const [lRoot, setLRoot] = useState(config.lidarr?.rootFolderPath ?? "");
  const [sUrl, setSUrl] = useState(config.slskd?.url ?? "");
  const [sKey, setSKey] = useState("");
  const [tested, setTested] = useState<string | null>(null);

  const save = async () => {
    const body: Record<string, unknown> = { acknowledged: accepted, noticeVersion: config.noticeVersion };
    body.lidarr = lUrl.trim() ? { url: lUrl.trim(), apiKey: lKey.trim(), rootFolderPath: lRoot.trim() } : null;
    body.slskd = sUrl.trim() ? { url: sUrl.trim(), apiKey: sKey.trim() } : null;
    const saved = await run(() => api<Config>("api/lidarr/config", { method: "PUT", body: JSON.stringify(body) }));
    if (saved) {
      setLKey("");
      setSKey("");
      onSaved();
    }
  };
  const test = async () => {
    setTested(null);
    const res = await run(() => api<{ lidarr: { ok: boolean; version?: string; message?: string } | null; slskd: { ok: boolean; connected?: boolean; version?: string; message?: string } | null }>("api/lidarr/test", { method: "POST" }));
    if (!res) return;
    const parts: string[] = [];
    if (res.lidarr) parts.push(res.lidarr.ok ? `Lidarr ${res.lidarr.version ?? ""} is reachable.` : `Lidarr: ${res.lidarr.message}`);
    if (res.slskd) parts.push(res.slskd.ok ? `slskd ${res.slskd.version ?? ""} is reachable${res.slskd.connected ? " and connected to Soulseek" : " but not connected to Soulseek"}.` : `slskd: ${res.slskd.message}`);
    setTested(parts.join(" ") || "Nothing is set up yet.");
  };

  return (
    <div className="ops-panel">
      <Notice tone="warn">
        <strong>Legal notice.</strong> {config.notice}
      </Notice>
      <Check checked={accepted} onChange={setAccepted}>
        I have read this and take responsibility for what I request.
      </Check>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="ops-grid">
        <Field label="Lidarr address" htmlFor="ld-url">
          <input id="ld-url" type="url" value={lUrl} onChange={(e) => setLUrl(e.target.value)} placeholder="http://lidarr:8686" />
        </Field>
        <Field label="Lidarr API key" hint={config.lidarr?.apiKeySet ? "A key is saved. Leave blank to keep it." : "Lidarr: Settings, General, Security."} htmlFor="ld-key">
          <input id="ld-key" type="password" autoComplete="off" value={lKey} onChange={(e) => setLKey(e.target.value)} />
        </Field>
        <Field label="Root folder (optional)" hint="Defaults to Lidarr's first root folder." htmlFor="ld-root">
          <input id="ld-root" type="text" value={lRoot} onChange={(e) => setLRoot(e.target.value)} placeholder="/music" />
        </Field>
        <Field label="slskd address (optional)" htmlFor="sk-url">
          <input id="sk-url" type="url" value={sUrl} onChange={(e) => setSUrl(e.target.value)} placeholder="http://slskd:5030" />
        </Field>
        <Field label="slskd API key" hint={config.slskd?.apiKeySet ? "A key is saved. Leave blank to keep it." : "Created in slskd's own configuration."} htmlFor="sk-key">
          <input id="sk-key" type="password" autoComplete="off" value={sKey} onChange={(e) => setSKey(e.target.value)} />
        </Field>
      </div>
      <div className="ops-actions">
        <button className="btn primary" disabled={busy || !accepted} onClick={() => void save()}>Save</button>
        <button className="btn" disabled={busy || !config.acknowledged} onClick={() => void test()}>Test connections</button>
      </div>
      {tested && <Notice tone="info">{tested}</Notice>}
      {config.acknowledged && <p className="muted small">Notice accepted by {config.acknowledged.by} on {formatWhen(config.acknowledged.at)}.</p>}
    </div>
  );
}

function Requests({ config }: { config: Config }) {
  const { api } = useOps();
  const { busy, error, run } = useAction();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AlbumHit[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const status = useLoad(() => api<LidarrStatus>("api/lidarr/status"), [config.lidarr?.url]);

  const search = async () => {
    setDone(null);
    const res = await run(() => api<{ items: AlbumHit[] }>(`api/lidarr/search?q=${encodeURIComponent(q.trim())}`));
    if (res) setHits(res.items);
  };
  const request = async (h: AlbumHit) => {
    const res = await run(() => api<{ action: string }>("api/lidarr/request", { method: "POST", body: JSON.stringify({ foreignAlbumId: h.foreignAlbumId }) }));
    if (res) {
      setDone(res.action === "added" ? `Asked Lidarr to add and search for ${h.title}.` : `${h.title} is now monitored and Lidarr is searching for it.`);
      status.reload();
    }
  };

  return (
    <div className="ops-panel">
      <h3 className="ld-sub">Request an album</h3>
      {error && <Notice tone="error">{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      <div className="ld-search">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Artist and album" aria-label="Search albums" onKeyDown={(e) => e.key === "Enter" && q.trim().length > 1 && void search()} />
        <button className="btn" disabled={busy || q.trim().length < 2} onClick={() => void search()}>Search</button>
      </div>
      {hits && hits.length === 0 && <p className="muted">Lidarr found nothing for that.</p>}
      <div className="ops-list">
        {hits?.map((h) => (
          <div className="ops-item" key={h.foreignAlbumId}>
            <div className="ops-item-text">
              <div className="ops-item-title">{h.title}</div>
              <div className="ops-item-sub">{h.artist}{h.releaseDate ? ` - ${h.releaseDate}` : ""}{h.albumType ? ` - ${h.albumType}` : ""}</div>
            </div>
            {h.inLibrary && h.monitored ? <span className="ops-pill ok">Monitored</span> : (
              <button className="btn" disabled={busy} onClick={() => void request(h)}>{h.inLibrary ? "Monitor and search" : "Request"}</button>
            )}
          </div>
        ))}
      </div>

      <div className="ops-section-head">
        <h3 className="ld-sub">Lidarr status</h3>
        <button className="btn ghost" onClick={status.reload}>Refresh</button>
      </div>
      {status.error && <Notice tone="error">{status.error}</Notice>}
      {status.data && (
        <>
          <p className="muted small">Lidarr {status.data.version ?? ""}: {status.data.missing} monitored album{status.data.missing === 1 ? "" : "s"} still missing, {status.data.queue.length} in the download queue.</p>
          <div className="ops-list">
            {status.data.queue.map((item, i) => (
              <div className="ops-item" key={`${item.title}-${i}`}>
                <div className="ops-item-text">
                  <div className="ops-item-title">{item.title}</div>
                  <div className="ops-item-sub">{item.artist ?? ""} - {item.status}{item.timeLeft ? ` - ${item.timeLeft} left` : ""}{item.errorMessage ? ` - ${item.errorMessage}` : ""}</div>
                  <div className="ops-meter" role="progressbar" aria-valuenow={item.progress} aria-valuemax={100}><span style={{ width: `${item.progress}%` }} /></div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {config.slskd && <Slskd />}
    </div>
  );
}

function Slskd() {
  const { api } = useOps();
  const { busy, error, run } = useAction();
  const [q, setQ] = useState("");
  const [id, setId] = useState<string | null>(null);
  const [result, setResult] = useState<SlskdResult | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const status = useLoad(() => api<{ connected: boolean; version: string | null; state: string | null }>("api/slskd/status"));

  useEffect(() => {
    if (!id) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<SlskdResult>(`api/slskd/search/${id}`);
        if (!alive) return;
        setResult(r);
        setPollError(null);
        if (!r.isComplete) timer = setTimeout(() => void poll(), 2500);
      } catch (err) {
        if (alive) setPollError(err instanceof Error ? err.message : "Could not read the search results.");
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, api]);

  const start = async () => {
    setResult(null);
    setPollError(null);
    const res = await run(() => api<{ id: string }>("api/slskd/search", { method: "POST", body: JSON.stringify({ query: q.trim() }) }));
    if (res) setId(res.id);
  };

  return (
    <>
      <h3 className="ld-sub">slskd (search and status only)</h3>
      {status.data && <p className="muted small">slskd {status.data.version ?? ""}: {status.data.connected ? "connected to Soulseek" : `not connected (${status.data.state ?? "unknown"})`}. Cadence never starts downloads; use slskd's own page for that.</p>}
      {status.error && <Notice tone="error">{status.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="ld-search">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the network" aria-label="Search slskd" onKeyDown={(e) => e.key === "Enter" && q.trim().length > 1 && void start()} />
        <button className="btn" disabled={busy || q.trim().length < 2} onClick={() => void start()}>Search</button>
      </div>
      {pollError && <Notice tone="error">{pollError}</Notice>}
      {id && !result && !pollError && <p className="muted small">Searching...</p>}
      {result && result.isComplete && result.responses.length === 0 && <p className="muted">Nobody answered that search.</p>}
      {result && (
        <>
          <p className="muted small">{result.isComplete ? "Finished" : "Searching"}: {result.responseCount} people, {result.fileCount} files.</p>
          <div className="ops-list">
            {result.responses.slice(0, 15).map((r) => (
              <div className="ops-item" key={r.username}>
                <div className="ops-item-text">
                  <div className="ops-item-title">{r.username} {r.freeUploadSlots && <span className="ops-pill ok">free slot</span>}</div>
                  <div className="ops-item-sub">{r.fileCount} file{r.fileCount === 1 ? "" : "s"}, for example {r.files[0]?.filename.split(/[\\/]/).pop() ?? ""}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Panel() {
  const { api } = useOps();
  const config = useLoad(() => api<Config>("api/lidarr/config"));
  return (
    <div className="ops-panel">
      {config.error && <Notice tone="error">{config.error}</Notice>}
      {config.data && <Settings config={config.data} onSaved={config.reload} />}
      {config.data?.acknowledged && config.data.lidarr && <Requests config={config.data} />}
    </div>
  );
}

const plugin: Plugin = {
  manifest: {
    id: "cadence.lidarr-slskd",
    name: "Lidarr and slskd",
    version: "1.0.0",
    description: "Admin tool, off until you accept a legal notice: request missing albums through your own Lidarr and search your own slskd. You are responsible for what you request.",
    author: "Cadence",
    capabilities: ["ui.settings"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "lidarr-slskd",
      title: "Lidarr and slskd",
      description: "Ask your own Lidarr for missing albums. Admins only.",
      icon: <DiscIcon size={19} />,
      keywords: ["lidarr", "slskd", "soulseek", "request", "missing albums", "arr"],
      render: () => (
        <NeedAdmin>
          <Panel />
        </NeedAdmin>
      ),
    });
  },
};

export default plugin;