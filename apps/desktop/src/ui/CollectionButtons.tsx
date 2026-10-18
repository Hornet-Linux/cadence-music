import { useEffect, useRef, useState } from "react";
import { useCollection, useIsLiked } from "@/features/collection/collectionStore";
import type { Track } from "@/shared/types";
import { HeartIcon, ListIcon, MoreIcon, PlusIcon } from "./icons";

/** Heart toggle for Liked Songs. */
export function LikeButton({ track, size = 16 }: { track: Track; size?: number }) {
  const liked = useIsLiked(track.id);
  const toggleLike = useCollection((s) => s.toggleLike);
  return (
    <button
      className={`icon-btn like-btn${liked ? " liked" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        toggleLike(track);
      }}
      aria-label={liked ? `Remove ${track.title} from Liked Songs` : `Add ${track.title} to Liked Songs`}
      aria-pressed={liked}
      data-tip={liked ? "Liked" : "Like"}
    >
      <HeartIcon size={size} filled={liked} />
    </button>
  );
}

/** Inline name field used to create or rename a playlist. */
export function NameField({
  initial = "",
  placeholder,
  onDone,
}: {
  initial?: string;
  placeholder: string;
  onDone: (name: string | null) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="name-field"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(name.trim() || null);
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={100}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone(null);
        }}
      />
    </form>
  );
}

/** "…" button with a menu to add a track to a playlist (or a new one). */
export function AddToPlaylistButton({ tracks, label }: { tracks: Track[]; label: string }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const playlists = useCollection((s) => s.playlists);
  const addToPlaylist = useCollection((s) => s.addToPlaylist);
  const createPlaylist = useCollection((s) => s.createPlaylist);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const done = () => {
    setOpen(false);
    setCreating(false);
  };

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip="Add to playlist"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <MoreIcon size={16} />
      </button>
      {open && (
        <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <div className="menu-title">Add to playlist</div>
          {creating ? (
            <NameField
              placeholder="New playlist name"
              onDone={(name) => {
                if (name) void createPlaylist(name, tracks);
                done();
              }}
            />
          ) : (
            <button role="menuitem" className="menu-item accent" onClick={() => setCreating(true)}>
              <PlusIcon size={16} /> New playlist
            </button>
          )}
          {playlists.map((p) => (
            <button
              key={p.id}
              role="menuitem"
              className="menu-item"
              onClick={() => {
                addToPlaylist(p.id, tracks);
                done();
              }}
            >
              <ListIcon size={16} /> <span className="menu-label">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
