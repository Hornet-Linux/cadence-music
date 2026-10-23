import { useCallback, useEffect, useRef, useState } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import { Segmented } from "@/features/settings/controls";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { usePlayer } from "@/player/playerStore";
import type { Track } from "@/shared/types";
import { BackIcon, PlayIcon, SearchIcon, ShuffleIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";
import { useServer } from "../../builtins/server/serverStore";
import { plainError, summarizeIndexing, type RemoteStatus } from "./logic";
import type { AlbumCard, RemoteSourceState } from "./store";
import "./style.css";

type Store<S extends RemoteStatus> = UseBoundStore<StoreApi<RemoteSourceState<S>>>;
type Tab = "tracks" | "albums";

const PAGE = 100;
const DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

interface Paged<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: string | null;
  more: () => void;
}

/** Load a list a page at a time; starts over whenever `key` changes. A late answer for an old key is dropped. */
function usePaged<T>(load: (offset: number) => Promise<{ items: T[]; total: number }>, key: string): Paged<T> {
  const [state, setState] = useState<{ items: T[]; total: number; loading: boolean; error: string | null }>({ items: [], total: 0, loading: true, error: null });
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const fetchPage = useCallback((offset: number) => {
    const id = ++seq.current;
    setState((s) => ({ ...(offset === 0 ? { items: [], total: 0 } : s), loading: true, error: null }));
    loadRef
      .current(offset)
      .then((page) => {
        if (id !== seq.current) return;
        setState((s) => ({ items: offset === 0 ? page.items : [...s.items, ...page.items], total: page.total, loading: false, error: null }));
      })
      .catch((e: unknown) => {
        if (id === seq.current) setState((s) => ({ ...s, loading: false, error: plainError(e) }));
      });
  }, []);

  useEffect(() => {
    const counter = seq;
    fetchPage(0);
    return () => {
      counter.current++;
    };
  }, [key, fetchPage]);

  const { items, loading } = state;
  const more = useCallback(() => {
    if (!loading) fetchPage(items.length);
  }, [loading, items.length, fetchPage]);
  return { ...state, more };
}

function PlayTools({ tracks, label }: { tracks: Track[]; label: string }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const shuffle = usePlayer((s) => s.shuffle);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  if (tracks.length === 0) return null;
  return (
    <div className="section-tools">
      <button className="btn primary" onClick={() => void playQueue(tracks, 0)} aria-label={`Play ${label}`}>
        <PlayIcon size={16} /> Play all
      </button>
      <button
        className="icon-btn"
        aria-label={`Shuffle ${label}`}
        data-tip="Shuffle"
        onClick={() => {
          if (!shuffle) toggleShuffle();
          void playQueue(tracks, Math.floor(Math.random() * tracks.length));
        }}
      >
        <ShuffleIcon size={16} />
      </button>
    </div>
  );
}

function Footer({ paged, noun }: { paged: Paged<unknown>; noun: string }) {
  const { items, total, loading, error, more } = paged;
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="empty">Loading {noun}…</p>}
      {!loading && items.length < total && (
        <button className="btn ghost show-more" onClick={more}>
          Show more ({total - items.length} left)
        </button>
      )}
    </>
  );
}

function Tracks<S extends RemoteStatus>({ store, q, album, label }: { store: Store<S>; q: string; album?: string; label: string }) {
  const listTracks = store((s) => s.listTracks);
  const running = store((s) => !!s.status?.indexing.running);
  // Reload when an index run starts or ends so the list isn't stale.
  const paged = usePaged((offset) => listTracks({ q, album, limit: PAGE, offset }), `${q}|${album ?? ""}|${running}`);
  return (
    <>
      <PlayTools tracks={paged.items} label={album ?? "tracks"} />
      {paged.items.length > 0 && (
        <div className="track-list">
          {paged.items.map((t, i) => (
            <TrackRow key={t.id} track={t} index={i} queue={paged.items} />
          ))}
        </div>
      )}
      {!paged.loading && !paged.error && paged.items.length === 0 && (
        <p className="empty">{q ? `No tracks match “${q}”.` : `Nothing from ${label} yet. If you just connected, it can take a few minutes to index.`}</p>
      )}
      <Footer paged={paged} noun="tracks" />
    </>
  );
}

function Albums<S extends RemoteStatus>({ store, q, onOpen }: { store: Store<S>; q: string; onOpen: (a: AlbumCard) => void }) {
  const listAlbums = store((s) => s.listAlbums);
  const paged = usePaged((offset) => listAlbums({ q, limit: PAGE, offset }), q);
  return (
    <>
      <ul className="rs-album-list">
        {paged.items.map((a) => (
          <li key={`${a.name}\n${a.artist ?? ""}`}>
            <button className="rs-album" onClick={() => onOpen(a)}>
              <span className="rs-album-name">{a.name}</span>
              <span className="muted small">
                {[a.artist, `${a.trackCount} ${a.trackCount === 1 ? "track" : "tracks"}`].filter(Boolean).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!paged.loading && !paged.error && paged.items.length === 0 && <p className="empty">{q ? `No albums match “${q}”.` : "No albums found yet."}</p>}
      <Footer paged={paged} noun="albums" />
    </>
  );
}

/**
 * The browse page for a remote source: its tracks and albums from the server's cache, with search.
 * Settings (connecting, folders) live in the settings panel; this page links there.
 */
export function RemoteSourcePage<S extends RemoteStatus>({
  store,
  title,
  label,
  settingsId,
  intro,
}: {
  store: Store<S>;
  title: string;
  label: string;
  settingsId: string;
  intro: string;
}) {
  const user = useServer((s) => s.user);
  const openSettings = useSettingsModal((s) => s.show);
  const status = store((s) => s.status);
  const unavailable = store((s) => s.unavailable);
  const checking = store((s) => s.checking);
  const error = store((s) => s.error);
  const refresh = store((s) => s.refresh);
  const [tab, setTab] = useState<Tab>("tracks");
  const [album, setAlbum] = useState<AlbumCard | null>(null);
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), DEBOUNCE_MS);

  // Look when the page opens (and keep following an index that is running).
  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  const connected = !!status?.connected;
  const sum = status ? summarizeIndexing(status.trackCount, status.indexing) : null;

  return (
    <div className="view rs-root">
      <header className="view-header">
        <h1>{title}</h1>
        <p className="muted">{connected && sum ? sum.text : intro}</p>
      </header>

      {!user ? (
        <div className="card pad stack">
          <p className="strong">Sign in to your server first</p>
          <p className="muted">{label} connects through your Cadence server.</p>
          <div>
            <button className="btn primary" onClick={() => openSettings("server")}>
              Open server settings
            </button>
          </div>
        </div>
      ) : unavailable ? (
        <div className="card pad stack">
          <p className="strong">{label} isn&apos;t turned on at your server</p>
          <p className="muted">The server owner can enable it under Settings, Plugins, and restart the server.</p>
        </div>
      ) : !status ? (
        <p className="empty">{checking ? `Checking ${label}…` : (error ?? `Couldn't check ${label}.`)}</p>
      ) : !connected ? (
        <div className="card pad stack">
          <p className="strong">Connect {label}</p>
          <p className="muted">{error ?? "Add your login in settings and your music will show up here."}</p>
          <div>
            <button className="btn primary" onClick={() => openSettings(settingsId)}>
              Open {label} settings
            </button>
          </div>
        </div>
      ) : (
        <>
          {sum?.problem && (
            <p className="notice warn" role="alert" style={{ marginBottom: 14 }}>
              {sum.problem}
            </p>
          )}
          {album ? (
            <>
              <div className="section-head">
                <button className="btn ghost" onClick={() => setAlbum(null)}>
                  <BackIcon size={16} /> Back
                </button>
              </div>
              <h2>{album.name}</h2>
              {album.artist && <p className="muted">{album.artist}</p>}
              <Tracks store={store} q="" album={album.name} label={label} />
            </>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 16, flexWrap: "wrap" }}>
                <Segmented
                  label={`${label} sections`}
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: "tracks", label: "Tracks" },
                    { value: "albums", label: "Albums" },
                  ]}
                />
                <button className="btn ghost" onClick={() => openSettings(settingsId)}>
                  Settings
                </button>
              </div>
              <div className="search-bar" style={{ marginBottom: 20 }}>
                <SearchIcon size={18} />
                <input
                  placeholder={tab === "albums" ? "Search albums…" : "Search songs, artists and folders…"}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label={`Search ${label}`}
                />
              </div>
              {tab === "tracks" ? <Tracks store={store} q={term} label={label} /> : <Albums store={store} q={term} onOpen={setAlbum} />}
            </>
          )}
        </>
      )}
    </div>
  );
}
