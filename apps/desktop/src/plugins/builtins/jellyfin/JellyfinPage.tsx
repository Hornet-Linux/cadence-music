import { useCallback, useEffect, useRef, useState } from "react";
import { Segmented } from "@/features/settings/controls";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { usePlayer } from "@/player/playerStore";
import type { Track } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { BackIcon, HeartIcon, PlayIcon, SearchIcon, ShuffleIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";
import { useServer } from "../server/serverStore";
import { useIsFavourite, useJellyfin, type JellyfinCard } from "./jellyfinStore";

type Tab = "tracks" | "albums" | "favourites" | "playlists";
type Open = { kind: "album" | "playlist"; card: JellyfinCard };

const PAGE = 100;
const DEBOUNCE_MS = 300;

/** Heart that toggles the track's favourite in Jellyfin (not Cadence's Liked Songs). */
export function FavouriteButton({ track }: { track: Track }) {
  const on = useIsFavourite(track);
  const toggle = useJellyfin((s) => s.toggleFavourite);
  return (
    <button
      className={`icon-btn like-btn${on ? " liked" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        void toggle(track);
      }}
      aria-label={on ? `Remove ${track.title} from Jellyfin favourites` : `Add ${track.title} to Jellyfin favourites`}
      aria-pressed={on}
      data-tip={on ? "Jellyfin favourite" : "Add to Jellyfin favourites"}
    >
      <HeartIcon size={16} filled={on} />
    </button>
  );
}

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

/** Load a list a page at a time; reloads from the start whenever `key` changes. */
function usePaged<T>(load: (offset: number) => Promise<{ items: T[]; total: number }>, key: string): Paged<T> {
  const [state, setState] = useState<{ items: T[]; total: number; loading: boolean; error: string | null }>({
    items: [],
    total: 0,
    loading: true,
    error: null,
  });
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
        if (id === seq.current) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      });
  }, []);

  useEffect(() => {
    const latest = seq;
    fetchPage(0);
    // A reply that lands after the list changed (or unmounted) is dropped.
    return () => {
      latest.current++;
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

function TrackList({ tracks, empty }: { tracks: Track[]; empty?: string }) {
  if (tracks.length === 0) return empty ? <p className="empty">{empty}</p> : null;
  return (
    <div className="track-list">
      {tracks.map((t, i) => (
        <TrackRow key={t.id} track={t} index={i} queue={tracks} likeAction={<FavouriteButton track={t} />} />
      ))}
    </div>
  );
}

function Status({ paged, noun }: { paged: Paged<unknown>; noun: string }) {
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

function Tracks({ q, favourites }: { q: string; favourites: boolean }) {
  const listTracks = useJellyfin((s) => s.listTracks);
  const paged = usePaged((offset) => listTracks({ q, favourites, limit: PAGE, offset }), `${q}|${favourites}`);
  const empty = favourites ? (q ? `No favourites match “${q}”.` : "You haven't added any favourites in Jellyfin yet.") : q ? `No tracks match “${q}”.` : "No tracks in this Jellyfin library.";
  return (
    <>
      <PlayTools tracks={paged.items} label={favourites ? "favourites" : "tracks"} />
      <TrackList tracks={paged.items} empty={paged.loading || paged.error ? undefined : empty} />
      <Status paged={paged} noun="tracks" />
    </>
  );
}

function Cards({ cards, onOpen }: { cards: JellyfinCard[]; onOpen: (card: JellyfinCard) => void }) {
  return (
    <div className="card-grid">
      {cards.map((c) => (
        <div className="media-card" key={c.id}>
          <button className="art" onClick={() => onOpen(c)} aria-label={`Open ${c.name}`}>
            <CoverArt src={c.artwork} seed={c.name} label={c.name} />
          </button>
          <div className="title" title={c.name}>
            {c.name}
          </div>
          <div className="subtitle" title={c.subtitle}>
            {c.subtitle ?? ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function Albums({ q, onOpen }: { q: string; onOpen: (card: JellyfinCard) => void }) {
  const listAlbums = useJellyfin((s) => s.listAlbums);
  const paged = usePaged((offset) => listAlbums({ q, limit: PAGE, offset }), q);
  return (
    <>
      <Cards cards={paged.items} onOpen={onOpen} />
      {!paged.loading && !paged.error && paged.items.length === 0 && (
        <p className="empty">{q ? `No albums match “${q}”.` : "No albums in this Jellyfin library."}</p>
      )}
      <Status paged={paged} noun="albums" />
    </>
  );
}

function Playlists({ onOpen }: { onOpen: (card: JellyfinCard) => void }) {
  const listPlaylists = useJellyfin((s) => s.listPlaylists);
  const paged = usePaged(async () => {
    const items = await listPlaylists();
    return { items, total: items.length };
  }, "playlists");
  return (
    <>
      <Cards cards={paged.items} onOpen={onOpen} />
      {!paged.loading && !paged.error && paged.items.length === 0 && <p className="empty">No playlists in Jellyfin yet.</p>}
      <Status paged={paged} noun="playlists" />
    </>
  );
}

/** The tracks of one album or playlist. */
function Detail({ open, onBack }: { open: Open; onBack: () => void }) {
  const albumTracks = useJellyfin((s) => s.albumTracks);
  const playlistTracks = useJellyfin((s) => s.playlistTracks);
  const { kind, card } = open;
  const paged = usePaged(async () => {
    const items = await (kind === "album" ? albumTracks(card.id) : playlistTracks(card.id));
    return { items, total: items.length };
  }, `${kind}:${card.id}`);

  return (
    <>
      <div className="section-head">
        <button className="btn ghost" onClick={onBack}>
          <BackIcon size={16} /> Back
        </button>
        <PlayTools tracks={paged.items} label={card.name} />
      </div>
      <h2>{card.name}</h2>
      {card.subtitle && <p className="muted">{card.subtitle}</p>}
      <TrackList tracks={paged.items} empty={paged.loading || paged.error ? undefined : "Nothing in here yet."} />
      <Status paged={paged} noun="tracks" />
    </>
  );
}

function Connect({ title, text, action }: { title: string; text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="card pad stack">
      <p className="strong">{title}</p>
      <p className="muted">{text}</p>
      {action && (
        <div>
          <button className="btn primary" onClick={action.onClick}>
            {action.label}
          </button>
        </div>
      )}
    </div>
  );
}

export function JellyfinPage() {
  const status = useJellyfin((s) => s.status);
  const checking = useJellyfin((s) => s.checking);
  const error = useJellyfin((s) => s.error);
  const serverUser = useServer((s) => s.user);
  const openSettings = useSettingsModal((s) => s.show);
  const [tab, setTab] = useState<Tab>("tracks");
  const [open, setOpen] = useState<Open | null>(null);
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), DEBOUNCE_MS);

  const connected = !!status?.connected;
  const settings = { label: "Open Jellyfin settings", onClick: () => openSettings("jellyfin") };

  function switchTab(next: Tab) {
    setTab(next);
    setOpen(null);
  }

  return (
    <div className="view">
      <header className="view-header">
        <h1>Jellyfin</h1>
        <p className="muted">
          {connected
            ? `${status.userName ?? "You"}${status.serverName ? ` on ${status.serverName}` : ""}`
            : "Your Jellyfin music, played through your Cadence server."}
        </p>
      </header>

      {!serverUser ? (
        <Connect
          title="Sign in to your server first"
          text="Jellyfin connects through your Cadence server."
          action={{ label: "Open server settings", onClick: () => openSettings("server") }}
        />
      ) : !status ? (
        <p className="empty">{checking ? "Checking Jellyfin…" : (error ?? "Couldn't check Jellyfin.")}</p>
      ) : !status.configured ? (
        <Connect title="Jellyfin isn't set up on this server" text="Ask the server owner to add its Jellyfin address." />
      ) : !connected ? (
        <Connect
          title="Sign in to Jellyfin"
          text={error ?? "Use your own Jellyfin account to browse and play your music here."}
          action={settings}
        />
      ) : (
        <>
          <div className="row" style={{ marginBottom: 16, flexWrap: "wrap" }}>
            <Segmented
              label="Jellyfin sections"
              value={tab}
              onChange={switchTab}
              options={[
                { value: "tracks", label: "Tracks" },
                { value: "albums", label: "Albums" },
                { value: "favourites", label: "Favourites" },
                { value: "playlists", label: "Playlists" },
              ]}
            />
          </div>
          {tab !== "playlists" && !open && (
            <div className="search-bar" style={{ marginBottom: 20 }}>
              <SearchIcon size={18} />
              <input
                placeholder={tab === "albums" ? "Search albums…" : "Search songs and artists…"}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search Jellyfin"
              />
            </div>
          )}
          {open ? (
            <Detail open={open} onBack={() => setOpen(null)} />
          ) : tab === "tracks" ? (
            <Tracks q={term} favourites={false} />
          ) : tab === "favourites" ? (
            <Tracks q={term} favourites />
          ) : tab === "albums" ? (
            <Albums q={term} onOpen={(card) => setOpen({ kind: "album", card })} />
          ) : (
            <Playlists onOpen={(card) => setOpen({ kind: "playlist", card })} />
          )}
        </>
      )}
    </div>
  );
}
