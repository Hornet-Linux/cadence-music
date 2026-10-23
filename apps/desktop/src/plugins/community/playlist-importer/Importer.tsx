import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCollection } from "@/features/collection/collectionStore";
import { useSettingsModal } from "@/features/settings/settingsStore";
import type { Track } from "@/shared/types";
import { usePluginHost } from "@/plugins/host";
import { spotifyFetch } from "@/plugins/builtins/spotify/api";
import { useSpotify } from "@/plugins/builtins/spotify/spotifyStore";
import { Field, Notice, NeedServer, OpsPage, Section, describeError, useOps } from "../_ops/ui";
import {
  chosenTrack,
  decodeText,
  makeRow,
  searchTracks,
  spotifyItemToRow,
  statusOf,
  summarize,
  topByPlays,
  type MatchCandidate,
  type Row,
  type RowStatus,
  type SpotifyPlaylistItem,
  type Wanted,
} from "./logic";

interface ParsedResponse {
  name?: string;
  format: string;
  items: Wanted[];
  warnings: string[];
  choices?: { id: string; name: string; trackCount: number }[];
}

interface MatchResponse {
  results: { index: number; candidates: MatchCandidate[] }[];
}

interface Imported {
  name: string;
  items: { wanted: Wanted; original?: Track }[];
  warnings: string[];
}

const CHUNK = 250;
const MAX_PLAYLIST = 5000;
const STATUS_LABEL: Record<RowStatus, string> = { matched: "Matched", review: "Check", original: "Kept as imported", missing: "Not found" };
const STATUS_TONE: Record<RowStatus, string> = { matched: "ok", review: "warn", original: "", missing: "bad" };

/** Collects the tracks of one library source (the sources are React hooks, so each needs a component). */
function SourceReader({ id, useTracks, onTracks }: { id: string; useTracks: () => Track[]; onTracks: (id: string, tracks: Track[]) => void }) {
  const tracks = useTracks();
  useEffect(() => onTracks(id, tracks), [id, tracks, onTracks]);
  return null;
}

function SourcePicker({ onImported, busy }: { onImported: (i: Imported) => void; busy: boolean }) {
  const { api } = useOps();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [choices, setChoices] = useState<{ file: string; filename: string; list: NonNullable<ParsedResponse["choices"]> } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const send = useCallback(
    async (content: string, filename: string, playlist?: string) => {
      setWorking(true);
      setError(null);
      try {
        const parsed = await api<ParsedResponse>("api/import/parse", { method: "POST", body: JSON.stringify({ text: content, filename, playlist }) });
        if (parsed.choices?.length) {
          setChoices({ file: content, filename, list: parsed.choices });
          return;
        }
        setChoices(null);
        if (parsed.items.length === 0) {
          setError(parsed.warnings[0] ?? "No tracks were found in that file.");
          return;
        }
        const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
        onImported({ name: parsed.name || base || "Imported playlist", items: parsed.items.map((wanted) => ({ wanted })), warnings: parsed.warnings });
      } catch (err) {
        setError(describeError(err));
      } finally {
        setWorking(false);
      }
    },
    [api, onImported],
  );

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 7 * 1024 * 1024) {
      setError("That file is larger than 7 MB. Split it or export a shorter list.");
      return;
    }
    await send(decodeText(await file.arrayBuffer()), file.name);
  };

  return (
    <Section title="1. Choose what to import" hint="M3U, XSPF, CSV, JSON, Apple Music or iTunes library files. Nothing is changed until you create the playlist.">
      {error && <Notice tone="error">{error}</Notice>}
      <div
        className="imp-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void onFile(e.dataTransfer.files[0]);
        }}
      >
        <input ref={fileInput} type="file" hidden accept=".m3u,.m3u8,.pls,.xspf,.csv,.tsv,.txt,.json,.xml" onChange={(e) => void onFile(e.target.files?.[0])} />
        <button className="btn" disabled={busy || working} onClick={() => fileInput.current?.click()}>
          {working ? "Reading..." : "Choose a file"}
        </button>
        <span className="muted small">or drop one here</span>
      </div>
      {choices && (
        <div className="ops-stack">
          <p className="muted">This library holds several playlists. Which one?</p>
          <div className="ops-list">
            {choices.list.map((c) => (
              <div className="ops-item" key={c.id}>
                <div className="ops-item-text">
                  <div className="ops-item-title">{c.name}</div>
                  <div className="ops-item-sub">{c.trackCount} tracks</div>
                </div>
                <button className="btn" onClick={() => void send(choices.file, choices.filename, c.id)}>
                  Use this
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <details>
        <summary>Paste a list instead</summary>
        <div className="ops-stack imp-paste">
          <Field label="One track per line, like 'Artist - Title', or the contents of a CSV" htmlFor="imp-paste">
            <textarea id="imp-paste" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Radiohead - Everything In Its Right Place\nBjork - Hyperballad"} />
          </Field>
          <div>
            <button className="btn" disabled={!text.trim() || working} onClick={() => void send(text, "pasted list")}>
              Read pasted list
            </button>
          </div>
        </div>
      </details>
      <details>
        <summary>Where do I get these files?</summary>
        <ul className="imp-help">
          <li><strong>Apple Music:</strong> in the Music app on a computer, File, Library, Export Playlist (text or XML). Or request your data from privacy.apple.com and use Apple Music Library Tracks.json.</li>
          <li><strong>Last.fm:</strong> a CSV or JSON export of your scrobbles. Songs you played many times are merged and ranked by plays.</li>
          <li><strong>Spotify:</strong> use the Spotify button below, or a CSV from a playlist export tool.</li>
          <li><strong>Anything else:</strong> a CSV with a Title column and optionally Artist, Album and Duration.</li>
        </ul>
      </details>
    </Section>
  );
}

function SpotifyImport({ onImported, busy }: { onImported: (i: Imported) => void; busy: boolean }) {
  const status = useSpotify((s) => s.status);
  const openSettings = useSettingsModal((s) => s.show);
  const [playlists, setPlaylists] = useState<{ id: string; name: string; tracks: { total: number } }[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = async () => {
    setError(null);
    setWorking("list");
    try {
      const all: { id: string; name: string; tracks: { total: number } }[] = [];
      let route: string | null = "me/playlists?limit=50";
      while (route && all.length < 500) {
        const page: { items: typeof all; next: string | null } = await spotifyFetch(route);
        all.push(...page.items.filter(Boolean));
        route = page.next;
      }
      setPlaylists(all);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setWorking(null);
    }
  };

  const load = async (p: { id: string; name: string }) => {
    setError(null);
    setWorking(p.id);
    try {
      const items: { wanted: Wanted; original: Track }[] = [];
      let route: string | null = `playlists/${encodeURIComponent(p.id)}/tracks?limit=100&fields=items(track(uri,name,duration_ms,is_local,artists(id,name),album(name,images))),next`;
      while (route && items.length < MAX_PLAYLIST) {
        const page: { items: SpotifyPlaylistItem[]; next: string | null } = await spotifyFetch(route);
        for (const it of page.items) {
          const row = spotifyItemToRow(it);
          if (row) items.push(row);
        }
        route = page.next;
      }
      if (items.length === 0) setError("No playable tracks were found in that playlist.");
      else onImported({ name: p.name, items, warnings: [] });
    } catch (err) {
      setError(`${describeError(err)} Spotify only lets this app read playlists you own or follow.`);
    } finally {
      setWorking(null);
    }
  };

  return (
    <Section title="Or import from Spotify" hint="Uses the Spotify account you already connected in Settings. Tracks are matched to your library; the ones you don't have can stay as Spotify tracks.">
      {status !== "signed-in" ? (
        <div className="ops-actions">
          <span className="muted">Spotify is not connected.</span>
          <button className="btn" onClick={() => openSettings("spotify")}>
            Connect Spotify
          </button>
        </div>
      ) : (
        <>
          {error && <Notice tone="error">{error}</Notice>}
          {!playlists && (
            <div>
              <button className="btn" disabled={busy || working !== null} onClick={() => void list()}>
                {working === "list" ? "Loading..." : "Show my Spotify playlists"}
              </button>
            </div>
          )}
          {playlists && (
            <div className="ops-list">
              {playlists.length === 0 && <p className="muted">No playlists found on that account.</p>}
              {playlists.map((p) => (
                <div className="ops-item" key={p.id}>
                  <div className="ops-item-text">
                    <div className="ops-item-title">{p.name}</div>
                    <div className="ops-item-sub">{p.tracks?.total ?? 0} tracks</div>
                  </div>
                  <button className="btn" disabled={busy || working !== null} onClick={() => void load(p)}>
                    {working === p.id ? "Loading..." : "Import"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
function RowEditor({ row, allTracks, onChange }: { row: Row; allTracks: Track[]; onChange: (row: Row) => void }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchTracks(allTracks, query), [allTracks, query]);
  return (
    <div className="imp-editor">
      <div className="ops-stack">
        {row.candidates.length > 0 && (
          <Field label="Suggestions">
            <div className="ops-list">
              {row.candidates.map((c, i) => (
                <label className="imp-choice" key={`${c.source}:${c.id}`}>
                  <input type="radio" name={`row-${row.key}`} checked={row.choice === i} onChange={() => onChange({ ...row, choice: i })} />
                  <span>
                    <span className="ops-item-title">{c.track?.title ?? c.id}</span>
                    <span className="ops-item-sub">
                      {c.track ? c.track.artists.map((a) => a.name).join(", ") : ""} - {Math.round(c.score * 100)}% match ({c.confidence})
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}
        {row.original && (
          <label className="imp-choice">
            <input type="radio" name={`row-${row.key}`} checked={row.choice === "original"} onChange={() => onChange({ ...row, choice: "original" })} />
            <span>Keep as the imported track ({row.original.source})</span>
          </label>
        )}
        <label className="imp-choice">
          <input type="radio" name={`row-${row.key}`} checked={row.choice === "skip"} onChange={() => onChange({ ...row, choice: "skip" })} />
          <span>Leave this track out</span>
        </label>
        <Field label="Find another track in your library" htmlFor={`find-${row.key}`}>
          <input id={`find-${row.key}`} type="search" value={query} placeholder="Title or artist" onChange={(e) => setQuery(e.target.value)} />
        </Field>
        {results.map((t) => (
          <button key={t.id} className={`imp-result${row.choice === "manual" && row.manual?.id === t.id ? " on" : ""}`} onClick={() => onChange({ ...row, choice: "manual", manual: t })}>
            <span className="ops-item-title">{t.title}</span>
            <span className="ops-item-sub">{t.artists.map((a) => a.name).join(", ")}{t.album ? ` - ${t.album}` : ""}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PreviewRow({ row, allTracks, lookup, onChange }: { row: Row; allTracks: Track[]; lookup: (id: string) => Track | undefined; onChange: (row: Row) => void }) {
  const [open, setOpen] = useState(false);
  const status = statusOf(row);
  const track = chosenTrack(row, lookup);
  const score = typeof row.choice === "number" ? row.candidates[row.choice]?.score : undefined;
  return (
    <div className={`imp-row ${status}`}>
      <div className="imp-row-main">
        <div className="ops-item-text">
          <div className="ops-item-title">
            {row.wanted.title}
            {(row.wanted.count ?? 1) > 1 && <span className="muted"> ({row.wanted.count} plays)</span>}
          </div>
          <div className="ops-item-sub">{row.wanted.artists.join(", ") || "Unknown artist"}{row.wanted.album ? ` - ${row.wanted.album}` : ""}</div>
        </div>
        <span className={`ops-pill ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}{score !== undefined && status !== "missing" ? ` ${Math.round(score * 100)}%` : ""}</span>
      </div>
      <div className="imp-row-match">
        <div className="ops-item-text">
          {track ? (
            <>
              <div className="ops-item-title">{track.title}</div>
              <div className="ops-item-sub">{track.artists.map((a) => a.name).join(", ")}{track.album ? ` - ${track.album}` : ""}</div>
            </>
          ) : (
            <div className="ops-item-sub">Nothing chosen. This track will not be added.</div>
          )}
        </div>
        <button className="btn ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Done" : "Change"}
        </button>
      </div>
      {open && <RowEditor row={row} allTracks={allTracks} onChange={onChange} />}
    </div>
  );
}

function ImporterPage() {
  const { api } = useOps();
  const sources = usePluginHost((s) => s.contributions.librarySources);
  const [bySource, setBySource] = useState<Record<string, Track[]>>({});
  const onTracks = useCallback((id: string, tracks: Track[]) => setBySource((prev) => (prev[id] === tracks ? prev : { ...prev, [id]: tracks })), []);
  const allTracks = useMemo(() => Object.values(bySource).flat(), [bySource]);
  const byId = useMemo(() => new Map(allTracks.map((t) => [t.id, t])), [allTracks]);
  const lookup = useCallback((id: string) => byId.get(id), [byId]);

  const [imported, setImported] = useState<Imported | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [topN, setTopN] = useState(100);
  const [filter, setFilter] = useState<"all" | "review" | "missing">("all");
  const [created, setCreated] = useState<{ name: string; count: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const isHistory = imported?.items.some((i) => (i.wanted.count ?? 1) > 1) ?? false;

  const run = useCallback(
    async (data: Imported, limit: number) => {
      setError(null);
      setCreated(null);
      const used = topByPlays(data.items, limit).slice(0, MAX_PLAYLIST);
      setRows(null);
      setProgress({ done: 0, total: used.length });
      // Tracks from other sources (Spotify, Jellyfin, local files) are offered to the matcher; the server library is searched in full by the server.
      const extra = Object.entries(bySource)
        .filter(([id]) => id !== "server")
        .flatMap(([, tracks]) => tracks)
        .slice(0, 8000)
        .map((t) => ({ id: t.id, title: t.title, artists: t.artists.map((a) => a.name), album: t.album, durationSec: t.durationSec }));
      try {
        const out: Row[] = [];
        for (let start = 0; start < used.length; start += CHUNK) {
          const chunk = used.slice(start, start + CHUNK);
          const res = await api<MatchResponse>("api/import/match", {
            method: "POST",
            body: JSON.stringify({ items: chunk.map((c) => ({ title: c.wanted.title, artists: c.wanted.artists, album: c.wanted.album, durationSec: c.wanted.durationSec })), extra }),
          });
          chunk.forEach((c, i) => out.push(makeRow(start + i, c.wanted, res.results[i]?.candidates ?? [], c.original)));
          setProgress({ done: Math.min(used.length, start + CHUNK), total: used.length });
        }
        setRows(out);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setProgress(null);
      }
    },
    [api, bySource],
  );

  const onImported = useCallback(
    (data: Imported) => {
      setImported(data);
      setName(data.name);
      void run(data, topN);
    },
    [run, topN],
  );

  const summary = useMemo(() => (rows ? summarize(rows, lookup) : null), [rows, lookup]);
  const shown = useMemo(() => {
    if (!rows) return [];
    if (filter === "review") return rows.filter((r) => statusOf(r) === "review");
    if (filter === "missing") return rows.filter((r) => !chosenTrack(r, lookup));
    return rows;
  }, [rows, filter, lookup]);

  const create = async () => {
    if (!summary || summary.tracks.length === 0) return;
    setSaving(true);
    try {
      await useCollection.getState().createPlaylist(name.trim() || "Imported playlist", summary.tracks);
      setCreated({ name: name.trim() || "Imported playlist", count: summary.tracks.length });
      setImported(null);
      setRows(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setImported(null);
    setRows(null);
    setError(null);
    setCreated(null);
  };

  return (
    <OpsPage title="Import a playlist" subtitle="Bring a playlist from Spotify, Apple Music, Last.fm or a file. Cadence finds each song in your library and shows you what it found before anything is saved.">
      {sources.map((s) => (
        <SourceReader key={s.id} id={s.id} useTracks={s.useTracks} onTracks={onTracks} />
      ))}
      <NeedServer>
        {created && (
          <Notice tone="ok">
            Created the playlist "{created.name}" with {created.count} track{created.count === 1 ? "" : "s"}. Find it under Library, Playlists.
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {!imported && (
          <>
            <SourcePicker onImported={onImported} busy={progress !== null} />
            <SpotifyImport onImported={onImported} busy={progress !== null} />
          </>
        )}
        {imported && (
          <Section
            title="2. Check the matches"
            hint={`${imported.items.length} track${imported.items.length === 1 ? "" : "s"} read from the file.`}
            actions={
              <button className="btn ghost" onClick={reset}>
                Start over
              </button>
            }
          >
            {imported.warnings.map((w) => (
              <Notice key={w} tone="warn">{w}</Notice>
            ))}
            {isHistory && (
              <Field label="Use the most played tracks" htmlFor="imp-top" hint="This file lists plays, so repeated songs were merged and ranked.">
                <select
                  id="imp-top"
                  value={topN}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setTopN(n);
                    void run(imported, n);
                  }}
                >
                  {[25, 50, 100, 250, 500, 1000].map((n) => (
                    <option key={n} value={n}>
                      Top {n}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {progress && (
              <div>
                <p className="muted small">Matching {progress.done} of {progress.total}...</p>
                <div className="ops-meter" role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total}>
                  <span style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                </div>
              </div>
            )}
            {summary && rows && (
              <>
                <div className="imp-summary" role="status">
                  <span className="ops-pill ok">{summary.matched} matched</span>
                  {summary.review > 0 && <span className="ops-pill warn">{summary.review} to check</span>}
                  {summary.original > 0 && <span className="ops-pill">{summary.original} kept as imported</span>}
                  <span className="ops-pill bad">{summary.missing} not found</span>
                </div>
                <div className="imp-filters" role="tablist" aria-label="Show">
                  {(["all", "review", "missing"] as const).map((f) => (
                    <button key={f} role="tab" aria-selected={filter === f} className={`btn ghost${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
                      {f === "all" ? `All (${rows.length})` : f === "review" ? "To check" : "Not found"}
                    </button>
                  ))}
                </div>
                <div className="imp-rows">
                  {shown.length === 0 && <p className="muted">Nothing here.</p>}
                  {shown.map((row) => (
                    <PreviewRow key={row.key} row={row} allTracks={allTracks} lookup={lookup} onChange={(next) => setRows((prev) => prev && prev.map((r) => (r.key === next.key ? next : r)))} />
                  ))}
                </div>
                <div className="imp-create">
                  <Field label="Playlist name" htmlFor="imp-name">
                    <input id="imp-name" type="text" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
                  </Field>
                  <button className="btn primary" disabled={saving || summary.tracks.length === 0} onClick={() => void create()}>
                    {saving ? "Creating..." : `Create playlist (${summary.tracks.length} tracks)`}
                  </button>
                </div>
              </>
            )}
          </Section>
        )}
      </NeedServer>
    </OpsPage>
  );
}

export default ImporterPage;