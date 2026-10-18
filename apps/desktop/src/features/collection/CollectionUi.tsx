import { useState, type ReactNode } from "react";
import { useNav } from "@/app/navStore";
import { usePlayer } from "@/player/playerStore";
import type { Track } from "@/shared/types";
import { CoverArt } from "@/ui/CoverArt";
import { NameField } from "@/ui/CollectionButtons";
import { HeartIcon, MoreIcon, PlayIcon, PlusIcon, ShuffleIcon, TrashIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";
import { useCollection, type Playlist } from "./collectionStore";

/** A 2×2 mosaic of the first artworks, like most music apps. */
export function PlaylistArt({ tracks, seed }: { tracks: Track[]; seed: string }) {
  const arts = tracks.filter((t) => t.artwork).slice(0, 4);
  if (arts.length < 4) {
    return <CoverArt src={arts[0]?.artwork} seed={seed} label={seed} />;
  }
  return (
    <div className="mosaic">
      {arts.map((t) => (
        <CoverArt key={t.id} src={t.artwork} seed={t.title} showInitial={false} />
      ))}
    </div>
  );
}

function totalTime(tracks: Track[]): string {
  const sec = tracks.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);
  if (sec >= 3600) return `${Math.floor(sec / 3600)} hr ${Math.round((sec % 3600) / 60)} min`;
  return sec > 0 ? `${Math.round(sec / 60)} min` : "";
}

function CollectionHeader({
  kind,
  title,
  tracks,
  art,
  actions,
  onTitleClick,
}: {
  kind: string;
  title: ReactNode;
  tracks: Track[];
  art: ReactNode;
  actions?: ReactNode;
  onTitleClick?: () => void;
}) {
  const playQueue = usePlayer((s) => s.playQueue);
  const shuffleOn = usePlayer((s) => s.shuffle);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  const meta = [`${tracks.length} song${tracks.length === 1 ? "" : "s"}`, totalTime(tracks)].filter(Boolean).join(" · ");
  return (
    <header className="collection-head">
      <div className="collection-art">{art}</div>
      <div className="collection-text">
        <span className="eyebrow">{kind}</span>
        {onTitleClick ? (
          <button className="collection-title as-button" onClick={onTitleClick} data-tip="Rename">
            {title}
          </button>
        ) : (
          <h1 className="collection-title">{title}</h1>
        )}
        <p className="muted">{meta}</p>
        <div className="collection-actions">
          <button className="btn primary big" disabled={tracks.length === 0} onClick={() => void playQueue(tracks, 0)}>
            <PlayIcon size={18} /> Play
          </button>
          <button
            className="btn ghost"
            disabled={tracks.length === 0}
            onClick={() => {
              if (!shuffleOn) toggleShuffle();
              void playQueue(tracks, Math.floor(Math.random() * tracks.length));
            }}
          >
            <ShuffleIcon size={17} /> Shuffle
          </button>
          {actions}
        </div>
      </div>
    </header>
  );
}

export function LikedView() {
  const likes = useCollection((s) => s.likes);
  const tracks = likes.map((l) => l.track);
  return (
    <div className="view">
      <CollectionHeader
        kind="Playlist"
        title="Liked Songs"
        tracks={tracks}
        art={
          <div className="liked-art">
            <HeartIcon size={64} filled />
          </div>
        }
      />
      {tracks.length === 0 ? (
        <div className="card pad">
          <p className="muted">
            Songs you like show up here. Hover a song and click the <HeartIcon size={14} /> to like it.
          </p>
        </div>
      ) : (
        <div className="track-list">
          {tracks.map((t, i) => (
            <TrackRow key={t.id} track={t} index={i} queue={tracks} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PlaylistView({ playlistId }: { playlistId: string }) {
  const playlist = useCollection((s) => s.playlists.find((p) => p.id === playlistId));
  const renamePlaylist = useCollection((s) => s.renamePlaylist);
  const deletePlaylist = useCollection((s) => s.deletePlaylist);
  const removeFromPlaylist = useCollection((s) => s.removeFromPlaylist);
  const navigate = useNav((s) => s.navigate);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!playlist) {
    return (
      <div className="view">
        <p className="empty">This playlist no longer exists.</p>
      </div>
    );
  }

  return (
    <div className="view">
      <CollectionHeader
        kind="Playlist"
        tracks={playlist.tracks}
        art={<PlaylistArt tracks={playlist.tracks} seed={playlist.name} />}
        title={
          renaming ? (
            <NameField
              initial={playlist.name}
              placeholder="Playlist name"
              onDone={(name) => {
                if (name) renamePlaylist(playlist.id, name);
                setRenaming(false);
              }}
            />
          ) : (
            playlist.name
          )
        }
        onTitleClick={renaming ? undefined : () => setRenaming(true)}
        actions={
          confirmDelete ? (
            <>
              <button
                className="btn danger"
                onClick={() => {
                  deletePlaylist(playlist.id);
                  navigate({ kind: "library" });
                }}
              >
                Delete playlist
              </button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="icon-btn" aria-label="Delete playlist" data-tip="Delete" onClick={() => setConfirmDelete(true)}>
              <TrashIcon size={18} />
            </button>
          )
        }
      />
      {playlist.tracks.length === 0 ? (
        <div className="card pad">
          <p className="muted">
            This playlist is empty. Hover any song and click <MoreIcon size={14} /> to add it here.
          </p>
        </div>
      ) : (
        <div className="track-list">
          {playlist.tracks.map((t, i) => (
            <TrackRow
              key={`${t.id}:${i}`}
              track={t}
              index={i}
              queue={playlist.tracks}
              onRemove={() => removeFromPlaylist(playlist.id, i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Liked Songs and playlist tiles for the Library page. */
export function CollectionShelf() {
  const likes = useCollection((s) => s.likes.length);
  const playlists = useCollection((s) => s.playlists);
  const createPlaylist = useCollection((s) => s.createPlaylist);
  const navigate = useNav((s) => s.navigate);
  const [creating, setCreating] = useState(false);

  const tile = (key: string, art: ReactNode, title: string, subtitle: string, onClick: () => void) => (
    <button key={key} className="collection-tile" onClick={onClick}>
      <span className="tile-art">{art}</span>
      <span className="tile-title">{title}</span>
      <span className="tile-sub">{subtitle}</span>
    </button>
  );

  return (
    <section className="section">
      <div className="section-head">
        <h2>Playlists</h2>
        {creating ? (
          <NameField
            placeholder="New playlist name"
            onDone={async (name) => {
              setCreating(false);
              if (name) navigate({ kind: "playlist", playlistId: await createPlaylist(name) });
            }}
          />
        ) : (
          <button className="btn ghost" onClick={() => setCreating(true)}>
            <PlusIcon size={16} /> New playlist
          </button>
        )}
      </div>
      <div className="collection-grid">
        {tile(
          "liked",
          <span className="liked-art">
            <HeartIcon size={40} filled />
          </span>,
          "Liked Songs",
          `${likes} song${likes === 1 ? "" : "s"}`,
          () => navigate({ kind: "liked" }),
        )}
        {playlists.map((p: Playlist) =>
          tile(
            p.id,
            <PlaylistArt tracks={p.tracks} seed={p.name} />,
            p.name,
            `${p.tracks.length} song${p.tracks.length === 1 ? "" : "s"}`,
            () => navigate({ kind: "playlist", playlistId: p.id }),
          ),
        )}
      </div>
    </section>
  );
}

