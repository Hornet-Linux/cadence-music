import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});

  const done = () => {
    setOpen(false);
    setCreating(false);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) done();
    };
    const closeNow = () => done();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", closeNow);
    // Scrolling the page would leave the menu floating away from its song.
    window.addEventListener("wheel", closeNow, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", closeNow);
      window.removeEventListener("wheel", closeNow);
    };
  }, [open]);

  const toggle = () => {
    if (open) return done();
    // The menu is drawn over the whole page (rows clip what overflows them),
    // anchored to the button and flipped upwards near the bottom.
    const rect = buttonRef.current!.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - rect.right);
    const below = window.innerHeight - rect.bottom;
    setPosition(
      below < 340
        ? { right, bottom: window.innerHeight - rect.top + 6 }
        : { right, top: rect.bottom + 6 },
    );
    setOpen(true);
  };

  return (
    <>
      <button
        ref={buttonRef}
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip="Add to playlist"
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        <MoreIcon size={16} />
      </button>
      {open &&
        createPortal(
        <div className="menu" role="menu" ref={menuRef} style={position} onClick={(e) => e.stopPropagation()}>
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
        </div>,
          document.body,
        )}
    </>
  );
}
