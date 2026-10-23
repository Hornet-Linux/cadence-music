import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { primaryArtist } from "@/shared/types";
import { fallbackPair } from "@/ui/color";
import { CoverArt } from "@/ui/CoverArt";
import { useLibraryTracks } from "../_social/libraryTracks";
import { Page, Tabs } from "../_social/ui";
import { filterAlbums, groupAlbums, pageOf, sortAlbums, staggerMs, type Album, type AlbumSort } from "./albums";
import "./style.css";

export const VINYL_ITEM_ID = "vinyl-wall";

function Sleeve({ album, index, onOpen }: { album: Album; index: number; onOpen: (a: Album) => void }) {
  const [a] = fallbackPair(album.title + album.artist);
  return (
    <li className="vw-item" style={{ ["--vw-delay" as string]: `${staggerMs(index)}ms` }}>
      <button className="vw-sleeve" onClick={() => onOpen(album)} aria-label={`${album.title} by ${album.artist}, ${album.tracks.length} songs`}>
        <span className="vw-disc" aria-hidden style={{ ["--vw-label" as string]: a }} />
        <span className="vw-cover">
          <CoverArt src={album.artwork} seed={album.title + album.artist} label={album.title} />
        </span>
      </button>
      <div className="vw-title" title={album.title}>
        {album.title}
      </div>
      <div className="vw-artist" title={album.artist}>
        {album.artist}
      </div>
    </li>
  );
}

function AlbumSheet({ album, onClose }: { album: Album; onClose: () => void }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const currentId = usePlayer((s) => s.current?.id);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="vw-backdrop" onClick={onClose}>
      <section className="vw-sheet" role="dialog" aria-modal="true" aria-label={album.title} onClick={(e) => e.stopPropagation()}>
        <div className="vw-sheet-head">
          <span className="vw-sheet-cover">
            <CoverArt src={album.artwork} seed={album.title + album.artist} label={album.title} />
          </span>
          <div className="sx-grow">
            <div className="eyebrow">{album.tracks.length} song{album.tracks.length === 1 ? "" : "s"}</div>
            <h2>{album.title}</h2>
            <div className="muted">{album.artist}</div>
          </div>
          <button ref={closeRef} className="sx-icon-btn" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="sx-row" style={{ margin: "12px 0" }}>
          <button className="btn primary" onClick={() => void playQueue(album.tracks, 0)}>
            Play
          </button>
          <button
            className="btn"
            onClick={() => void playQueue(album.tracks, Math.floor(Math.random() * album.tracks.length))}
          >
            Start anywhere
          </button>
        </div>
        <ol className="sx-list vw-tracks">
          {album.tracks.map((t, i) => (
            <li key={t.id} className={currentId === t.id ? "vw-playing" : ""}>
              <button className="vw-track" onClick={() => void playQueue(album.tracks, i)}>
                <span className="sx-rank">{i + 1}</span>
                <span className="sx-grow" style={{ textAlign: "left" }}>
                  <span className="sx-title" style={{ display: "block" }}>{t.title}</span>
                  {primaryArtist(t) !== album.artist && <span className="sx-sub" style={{ display: "block" }}>{primaryArtist(t)}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export function VinylWall() {
  const library = useLibraryTracks({ includeHistory: false });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AlbumSort>("title");
  const [pages, setPages] = useState(1);
  const [open, setOpen] = useState<Album | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const albums = useMemo(() => sortAlbums(filterAlbums(groupAlbums(library), query), sort), [library, query, sort]);
  const shown = pageOf(albums, pages);
  const more = shown.length < albums.length;

  useEffect(() => setPages(1), [query, sort]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setPages((p) => p + 1), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, shown.length]);

  return (
    <Page className="vw-page" title="Vinyl wall" subtitle="Browse your library as a shelf of records. Tap a sleeve to open it.">
      <div className="vw-tools">
        <input className="text-input vw-search" type="search" aria-label="Search albums" placeholder="Search albums, artists or songs" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Tabs
          label="Sort"
          value={sort}
          onChange={setSort}
          options={[
            { id: "title", label: "Album" },
            { id: "artist", label: "Artist" },
            { id: "size", label: "Biggest" },
          ]}
        />
      </div>
      {library.length === 0 ? (
        <div className="sx-card">
          <p>Your shelf is empty.</p>
          <p className="muted small">Connect your server or add local files, and your albums appear here.</p>
        </div>
      ) : albums.length === 0 ? (
        <p className="muted">Nothing matches "{query}".</p>
      ) : (
        <>
          <p className="muted small" aria-live="polite">
            {albums.length} album{albums.length === 1 ? "" : "s"}
          </p>
          <ul className="vw-wall">
            {shown.map((a, i) => (
              <Sleeve key={a.key} album={a} index={i} onOpen={setOpen} />
            ))}
          </ul>
          {more && (
            <div ref={sentinel} className="vw-more">
              <button className="btn ghost" onClick={() => setPages((p) => p + 1)}>
                Show more
              </button>
            </div>
          )}
        </>
      )}
      {open && <AlbumSheet album={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}