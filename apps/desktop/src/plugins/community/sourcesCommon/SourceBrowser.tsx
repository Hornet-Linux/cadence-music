import { useState, type ReactNode } from "react";
import { Segmented } from "@/features/settings/controls";
import { usePlayer } from "@/player/playerStore";
import type { Track } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { BackIcon, HeartIcon, PlayIcon, SearchIcon, ShuffleIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";
import { useDebounced, usePaged, type Paged } from "./hooks";
import type { BrowseApi, Card } from "./types";
import "./style.css";

type Tab = "tracks" | "albums" | "artists" | "playlists" | "favourites";
type Open = { kind: "album" | "playlist" | "artist"; card: Card };

const PAGE = 100;
const DEBOUNCE_MS = 300;

function FavouriteButton({ api, track }: { api: BrowseApi; track: Track }) {
  const on = api.useIsFavourite(track);
  return (
    <button
      className={`icon-btn like-btn${on ? " liked" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        void api.toggleFavourite(track);
      }}
      aria-label={on ? `Remove ${track.title} from ${api.label} favourites` : `Add ${track.title} to ${api.label} favourites`}
      aria-pressed={on}
      data-tip={on ? `${api.label} favourite` : `Add to ${api.label} favourites`}
    >
      <HeartIcon size={16} filled={on} />
    </button>
  );
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

function TrackList({ api, tracks, empty }: { api: BrowseApi; tracks: Track[]; empty?: string }) {
  if (tracks.length === 0) return empty ? <p className="empty">{empty}</p> : null;
  return (
    <div className="track-list">
      {tracks.map((t, i) => (
        <TrackRow key={t.id} track={t} index={i} queue={tracks} likeAction={<FavouriteButton api={api} track={t} />} />
      ))}
    </div>
  );
}

function Status({ paged, noun }: { paged: Paged<unknown>; noun: string }) {
  const { loading, error, hasMore, more } = paged;
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="empty">Loading {noun}…</p>}
      {!loading && hasMore && (
        <button className="btn ghost show-more" onClick={more}>
          Show more
        </button>
      )}
    </>
  );
}

function Cards({ cards, onOpen }: { cards: Card[]; onOpen: (card: Card) => void }) {
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

function Tracks({ api, q, favourites }: { api: BrowseApi; q: string; favourites: boolean }) {
  const paged = usePaged((offset) => api.listTracks({ q, favourites, limit: PAGE, offset }), `${q}|${favourites}`);
  const empty = favourites
    ? q
      ? `No favourites match “${q}”.`
      : `You haven't added any favourites in ${api.label} yet.`
    : q
      ? `No tracks match “${q}”.`
      : `No tracks in this ${api.label} library.`;
  return (
    <>
      <PlayTools tracks={paged.items} label={favourites ? "favourites" : "tracks"} />
      <TrackList api={api} tracks={paged.items} empty={paged.loading || paged.error ? undefined : empty} />
      <Status paged={paged} noun="tracks" />
    </>
  );
}

function Albums({ api, q, artistId, onOpen }: { api: BrowseApi; q: string; artistId?: string; onOpen: (card: Card) => void }) {
  const paged = usePaged((offset) => api.listAlbums({ q, artistId, limit: PAGE, offset }), `${q}|${artistId ?? ""}`);
  return (
    <>
      <Cards cards={paged.items} onOpen={onOpen} />
      {!paged.loading && !paged.error && paged.items.length === 0 && <p className="empty">{q ? `No albums match “${q}”.` : `No albums in this ${api.label} library.`}</p>}
      <Status paged={paged} noun="albums" />
    </>
  );
}

function Artists({ api, q, onOpen }: { api: BrowseApi; q: string; onOpen: (card: Card) => void }) {
  const paged = usePaged((offset) => api.listArtists({ q, limit: PAGE, offset }), q);
  return (
    <>
      <Cards cards={paged.items} onOpen={onOpen} />
      {!paged.loading && !paged.error && paged.items.length === 0 && <p className="empty">{q ? `No artists match “${q}”.` : `No artists in this ${api.label} library.`}</p>}
      <Status paged={paged} noun="artists" />
    </>
  );
}

function Playlists({ api, onOpen }: { api: BrowseApi; onOpen: (card: Card) => void }) {
  const paged = usePaged(async () => {
    const items = await api.listPlaylists();
    return { items, total: items.length, hasMore: false };
  }, "playlists");
  return (
    <>
      <Cards cards={paged.items} onOpen={onOpen} />
      {!paged.loading && !paged.error && paged.items.length === 0 && <p className="empty">No playlists in {api.label} yet.</p>}
      <Status paged={paged} noun="playlists" />
    </>
  );
}

/** The contents of an album, playlist or artist. */
function Detail({ api, open, onBack, onOpen }: { api: BrowseApi; open: Open; onBack: () => void; onOpen: (card: Card) => void }) {
  const { kind, card } = open;
  return (
    <>
      <div className="section-head">
        <button className="btn ghost" onClick={onBack}>
          <BackIcon size={16} /> Back
        </button>
      </div>
      <h2>{card.name}</h2>
      {card.subtitle && <p className="muted">{card.subtitle}</p>}
      {kind === "artist" ? <Albums api={api} q="" artistId={card.id} onOpen={onOpen} /> : <TrackDetail api={api} open={open} />}
    </>
  );
}

function TrackDetail({ api, open }: { api: BrowseApi; open: Open }) {
  const { kind, card } = open;
  const paged = usePaged(async () => {
    const items = await (kind === "album" ? api.albumTracks(card.id) : api.playlistTracks(card.id));
    return { items, total: items.length, hasMore: false };
  }, `${kind}:${card.id}`);
  return (
    <>
      <PlayTools tracks={paged.items} label={card.name} />
      <TrackList api={api} tracks={paged.items} empty={paged.loading || paged.error ? undefined : "Nothing in here yet."} />
      <Status paged={paged} noun="tracks" />
    </>
  );
}

const PLACEHOLDERS: Record<Tab, string> = {
  tracks: "Search songs, artists and albums…",
  albums: "Search albums…",
  artists: "Search artists…",
  playlists: "",
  favourites: "Search favourites…",
};

/** Tabs, search and drill-down over a music source's library. Shown once the person is connected. */
export function SourceBrowser({ api, header }: { api: BrowseApi; header?: ReactNode }) {
  const [tab, setTab] = useState<Tab>("tracks");
  const [stack, setStack] = useState<Open[]>([]);
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), DEBOUNCE_MS);
  const open = stack[stack.length - 1] ?? null;

  function switchTab(next: Tab) {
    setTab(next);
    setStack([]);
  }
  const push = (kind: Open["kind"]) => (card: Card) => setStack((s) => [...s, { kind, card }]);

  return (
    <>
      {header}
      <div className="src-tabs">
        <Segmented
          label={`${api.label} sections`}
          value={tab}
          onChange={switchTab}
          options={[
            { value: "tracks", label: "Tracks" },
            { value: "albums", label: "Albums" },
            { value: "artists", label: "Artists" },
            { value: "playlists", label: "Playlists" },
            { value: "favourites", label: "Favourites" },
          ]}
        />
      </div>
      {tab !== "playlists" && !open && (
        <div className="search-bar src-search">
          <SearchIcon size={18} />
          <input placeholder={PLACEHOLDERS[tab]} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${api.label}`} />
        </div>
      )}
      {open ? (
        <Detail api={api} open={open} onBack={() => setStack((s) => s.slice(0, -1))} onOpen={push("album")} />
      ) : tab === "tracks" ? (
        <Tracks api={api} q={term} favourites={false} />
      ) : tab === "favourites" ? (
        <Tracks api={api} q={term} favourites />
      ) : tab === "albums" ? (
        <Albums api={api} q={term} onOpen={push("album")} />
      ) : tab === "artists" ? (
        <Artists api={api} q={term} onOpen={push("artist")} />
      ) : (
        <Playlists api={api} onOpen={push("playlist")} />
      )}
    </>
  );
}

/** A card with a title, a line of text and an optional button, for the not-connected states. */
export function ConnectCard({ title, text, action }: { title: string; text: string; action?: { label: string; onClick: () => void } }) {
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