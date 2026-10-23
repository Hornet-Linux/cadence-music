import { useEffect, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { BackIcon, PauseIcon, PlayIcon, SearchIcon, TrashIcon } from "@/ui/icons";
import { describeError, useDebounced, useLoad } from "../_sourcekit/api";
import { clock, SPEEDS, speedLabel, spoken } from "../_sourcekit/format";
import { Back15Icon, BookmarkIcon, Fwd30Icon, MoonIcon } from "../_sourcekit/icons";
import { Art, Bar, Chips, IconButton, PageHeader, Problem, SignInGate, joinFacts, LoadingRows } from "../_sourcekit/ui";
import { addBookmark, bookIdOf, bookToTrack, chapterAt, fetchBook, fetchBookmarks, fetchBooks, fetchLibraries, removeBookmark, SLEEP_MINUTES, startBookAt, useAudiobooks, type Book } from "./audiobookStore";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "../../builtins/server/serverStore";

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Plays a book from `at` seconds (or from where it was left). If it is already loaded, jumps there. */
function playBook(book: Book, at?: number) {
  const player = usePlayer.getState();
  const track = bookToTrack(book);
  if (player.current?.id === track.id && at !== undefined) {
    player.seek(at);
    if (!player.isPlaying) player.toggle();
    return;
  }
  if (player.current?.id === track.id) {
    player.toggle();
    return;
  }
  if (at !== undefined) startBookAt(book.id, at);
  void player.playQueue([track], 0);
}

function SleepControls() {
  const sleep = useAudiobooks((s) => s.sleep);
  const startSleep = useAudiobooks((s) => s.startSleep);
  const position = usePlayer((s) => s.position);
  const now = useNow(15_000);
  const label =
    sleep === null ? "Sleep timer off" : sleep.kind === "minutes" ? `Pausing in ${Math.max(1, Math.round((sleep.until - now) / 60_000))} min` : "Pausing at the end of this chapter";
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="sk-sub row" style={{ gap: 6, alignItems: "center" }}>
        <MoonIcon size={16} /> <span role="status">{label}</span>
      </span>
      <div className="sk-chips" role="group" aria-label="Sleep timer">
        {SLEEP_MINUTES.map((m) => (
          <button key={m} className="sk-pill" onClick={() => startSleep({ minutes: m }, position)}>
            {m} min
          </button>
        ))}
        <button className="sk-pill" onClick={() => startSleep("chapter", position)}>
          End of chapter
        </button>
        {sleep && (
          <button className="sk-pill on" onClick={() => startSleep(null, position)}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function NowListening() {
  const current = usePlayer((s) => s.current);
  const playing = usePlayer((s) => s.isPlaying);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const toggle = usePlayer((s) => s.toggle);
  const seek = usePlayer((s) => s.seek);
  const active = useAudiobooks((s) => s.current);
  const setSpeed = useAudiobooks((s) => s.setSpeed);
  const id = current ? bookIdOf(current) : null;
  if (!current || !id) return null;
  const chapter = active ? chapterAt(active.chapters, position) : null;
  const rate = active?.rate ?? 1;
  return (
    <section className="sk-now" aria-label="Now listening">
      <div className="sk-now-top">
        <Art src={current.artwork} seed={current.title} label={current.title} size={56} />
        <div style={{ minWidth: 0 }}>
          <span className="sk-title">{current.title}</span>
          <span className="sk-sub">{joinFacts([chapter?.title, `${clock(position)} of ${clock(duration)}`])}</span>
        </div>
      </div>
      <Bar position={position} duration={duration} label="Book progress" />
      <div className="sk-now-controls">
        <IconButton label="Back 15 seconds" onClick={() => seek(Math.max(0, position - 15))}>
          <Back15Icon size={24} />
        </IconButton>
        <IconButton label={playing ? "Pause" : "Play"} onClick={toggle}>
          {playing ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
        </IconButton>
        <IconButton label="Forward 30 seconds" onClick={() => seek(position + 30)}>
          <Fwd30Icon size={24} />
        </IconButton>
      </div>
      <div className="sk-chips" role="radiogroup" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button key={s} role="radio" aria-checked={Math.abs(rate - s) < 0.01} className={`sk-pill${Math.abs(rate - s) < 0.01 ? " on" : ""}`} onClick={() => setSpeed(s)}>
            {speedLabel(s)}
          </button>
        ))}
      </div>
      <SleepControls />
    </section>
  );
}

function BookDetail({ book: initial, onBack }: { book: Book; onBack: () => void }) {
  const detail = useLoad(() => fetchBook(initial.id), initial.id, "audiobooks");
  const marks = useLoad(() => fetchBookmarks(initial.id), `marks:${initial.id}`, "audiobooks");
  const book = detail.data ?? initial;
  const chapters = detail.data?.chapters ?? [];
  const position = usePlayer((s) => s.position);
  const isCurrent = usePlayer((s) => s.current?.id === `audiobook:${initial.id}`);
  const playing = usePlayer((s) => s.isPlaying);
  const [markError, setMarkError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const here = isCurrent ? chapterAt(chapters, position) : null;
  const saved = book.progress && !book.progress.isFinished ? book.progress.currentTime : 0;

  async function mark() {
    setMarkError(null);
    const at = Math.floor(position);
    const title = name.trim() || (here ? `${here.title} at ${clock(at)}` : `At ${clock(at)}`);
    try {
      await addBookmark(initial.id, at, title);
      setName("");
      marks.reload();
    } catch (e) {
      setMarkError(describeError(e, "audiobooks"));
    }
  }

  return (
    <>
      <button className="btn ghost" onClick={onBack} style={{ minHeight: 44, marginBottom: 12 }}>
        <BackIcon size={16} /> Back
      </button>
      <div className="sk-detail-head">
        <Art src={book.cover} seed={book.title} label={book.title} size={112} />
        <div style={{ minWidth: 0 }}>
          <h2>{book.title}</h2>
          <p className="sk-facts">{joinFacts([book.author, book.narrator && `Read by ${book.narrator}`, book.series, spoken(book.durationSec)])}</p>
          <div className="sk-now-controls" style={{ marginTop: 8 }}>
            <button className="btn primary" style={{ minHeight: 44 }} onClick={() => playBook(book)}>
              {isCurrent && playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />} {isCurrent ? (playing ? "Pause" : "Resume") : saved > 30 ? `Resume at ${clock(saved)}` : "Play"}
            </button>
          </div>
          {book.progress && <Bar position={book.progress.currentTime} duration={book.durationSec} label="Progress" />}
        </div>
      </div>
      <Problem message={detail.error} onRetry={detail.reload} />
      {book.description && <p className="sk-text">{book.description}</p>}

      <p className="sk-section">Bookmarks</p>
      <form
        className="sk-form"
        onSubmit={(e) => {
          e.preventDefault();
          void mark();
        }}
      >
        <input className="sk-field" placeholder={isCurrent ? "Name this spot (optional)" : "Play the book to add a bookmark"} value={name} onChange={(e) => setName(e.target.value)} disabled={!isCurrent} aria-label="Bookmark name" />
        <button className="btn" type="submit" style={{ minHeight: 44 }} disabled={!isCurrent}>
          <BookmarkIcon size={16} /> Add bookmark
        </button>
      </form>
      <Problem message={markError ?? marks.error} />
      <div className="sk-list" role="list">
        {(marks.data ?? []).map((m) => (
          <div className="sk-row" key={`${m.time}-${m.title}`} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
            <button className="sk-main" onClick={() => playBook(book, m.time)} aria-label={`Go to bookmark ${m.title}`}>
              <span className="sk-title">{m.title}</span>
              <span className="sk-sub">{clock(m.time)}</span>
            </button>
            <IconButton
              label={`Delete bookmark ${m.title}`}
              onClick={() =>
                void removeBookmark(initial.id, m.time).then(
                  () => marks.reload(),
                  (e: unknown) => setMarkError(describeError(e, "audiobooks")),
                )
              }
            >
              <TrashIcon size={16} />
            </IconButton>
          </div>
        ))}
      </div>
      {!marks.loading && (marks.data ?? []).length === 0 && <p className="sk-sub">No bookmarks yet.</p>}

      {chapters.length > 0 && (
        <>
          <p className="sk-section">Chapters</p>
          <div className="sk-list" role="list">
            {chapters.map((c) => (
              <div className={`sk-row${here?.index === c.index ? " current" : ""}`} key={c.index} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
                <button className="sk-main" onClick={() => playBook(book, c.start)} aria-label={`Play from ${c.title}`}>
                  <span className="sk-title">{c.title}</span>
                  <span className="sk-sub">{joinFacts([clock(c.start), spoken(c.end - c.start)])}</span>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Shelf({ books, onOpen }: { books: Book[]; onOpen: (b: Book) => void }) {
  return (
    <div className="sk-grid">
      {books.map((b) => (
        <button key={b.id} className="sk-tile" onClick={() => onOpen(b)} aria-label={`${b.title}${b.author ? ` by ${b.author}` : ""}`}>
          <Art src={b.cover} seed={b.title} label={b.title} />
          <span className="sk-title">{b.title}</span>
          <span className="sk-sub">{b.author}</span>
          {b.progress && !b.progress.isFinished && <Bar position={b.progress.currentTime} duration={b.durationSec} label={`Progress of ${b.title}`} />}
        </button>
      ))}
    </div>
  );
}

function ContinueView({ onOpen }: { onOpen: (b: Book) => void }) {
  const books = useAudiobooks((s) => s.continueBooks);
  const loaded = useAudiobooks((s) => s.continueLoaded);
  return (
    <>
      <Shelf books={books} onOpen={onOpen} />
      {!loaded && <LoadingRows label="Loading…" />}
      {loaded && books.length === 0 && <p className="empty">Nothing in progress. Pick a book from your library.</p>}
    </>
  );
}

function LibraryView({ onOpen }: { onOpen: (b: Book) => void }) {
  const libs = useLoad(fetchLibraries, "libraries", "audiobooks");
  const [lib, setLib] = useState("");
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 350);
  const libraryId = lib || libs.data?.[0]?.id || "";
  const [more, setMore] = useState<Book[]>([]);
  const [busy, setBusy] = useState(false);
  const first = useLoad(() => (libraryId ? fetchBooks(libraryId, { q: term }) : Promise.resolve({ items: [], total: 0, page: 0 })), `${libraryId}|${term}`, "audiobooks");
  useEffect(() => setMore([]), [libraryId, term]);
  const books = [...(first.data?.items ?? []), ...more];
  const total = first.data?.total ?? 0;
  async function showMore() {
    setBusy(true);
    try {
      const page = await fetchBooks(libraryId, { q: term, page: Math.floor(books.length / 36) });
      setMore((m) => [...m, ...page.items.filter((b) => !books.some((x) => x.id === b.id))]);
    } catch {
      // Try again with the button.
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {(libs.data?.length ?? 0) > 1 && (
        <div className="sk-toolbar">
          <Chips label="Library" value={libraryId} onChange={setLib} options={(libs.data ?? []).map((l) => ({ value: l.id, label: l.name }))} />
        </div>
      )}
      <div className="sk-toolbar">
        <div className="search-bar">
          <SearchIcon size={18} />
          <input placeholder="Search books, authors, series…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search audiobooks" />
        </div>
      </div>
      <Problem message={libs.error ?? first.error} onRetry={() => (libs.error ? libs.reload() : first.reload())} />
      <Shelf books={books} onOpen={onOpen} />
      {(libs.loading || first.loading) && <LoadingRows label="Loading…" />}
      {!first.loading && !first.error && libraryId && books.length === 0 && <p className="empty">{term ? `No books match “${term}”.` : "This library has no books yet."}</p>}
      {!term && books.length > 0 && books.length < total && (
        <button className="btn ghost show-more" disabled={busy} onClick={() => void showMore()}>
          Show more ({total - books.length} left)
        </button>
      )}
    </>
  );
}

export function AudiobooksPage() {
  const status = useAudiobooks((s) => s.status);
  const checking = useAudiobooks((s) => s.checking);
  const error = useAudiobooks((s) => s.error);
  const refresh = useAudiobooks((s) => s.refreshStatus);
  const openSettings = useSettingsModal((s) => s.show);
  const isAdmin = useServer((s) => !!s.user?.isAdmin);
  const [tab, setTab] = useState<"continue" | "library">("continue");
  const [open, setOpen] = useState<Book | null>(null);
  useEffect(() => {
    if (!status) void refresh();
  }, [status, refresh]);
  const connected = !!status?.connected;
  return (
    <div className="view">
      <PageHeader title="Audiobooks">{connected ? `Signed in to Audiobookshelf as ${status?.userName ?? "you"}. Your place is saved back there as you listen.` : "Listen to your Audiobookshelf library, with your own account."}</PageHeader>
      <SignInGate what="Audiobookshelf">
        {!status ? (
          checking ? (
          <LoadingRows label="Checking Audiobookshelf…" rows={3} />
        ) : (
          <Problem message={error ?? "Couldn't reach Audiobookshelf."} onRetry={() => void refresh()} />
        )
        ) : !status.configured ? (
          <div className="card pad stack">
            <p className="strong">Audiobookshelf isn&apos;t set up on this server</p>
            <p className="muted">
              {isAdmin ? "Add your Audiobookshelf address in Settings, Audiobooks. Everyone then signs in with their own account." : "The server owner adds its address in Settings, Audiobooks."}
            </p>
            {isAdmin && (
              <div>
                <button className="btn primary" style={{ minHeight: 44 }} onClick={() => openSettings("audiobooks")}>
                  Set up Audiobookshelf
                </button>
              </div>
            )}
          </div>
        ) : !connected ? (
          <div className="card pad stack">
            <p className="strong">Sign in to Audiobookshelf</p>
            <p className="muted">{error ?? "Use your own Audiobookshelf account to browse and play your books here."}</p>
            <div>
              <button className="btn primary" style={{ minHeight: 44 }} onClick={() => openSettings("audiobooks")}>
                Sign in
              </button>
            </div>
          </div>
        ) : (
          <>
            <NowListening />
            {open ? (
              <BookDetail book={open} onBack={() => setOpen(null)} />
            ) : (
              <>
                <div className="sk-toolbar">
                  <Chips
                    label="Audiobook sections"
                    value={tab}
                    onChange={setTab}
                    options={[
                      { value: "continue", label: "Continue" },
                      { value: "library", label: "Library" },
                    ]}
                  />
                </div>
                {tab === "continue" ? <ContinueView onOpen={setOpen} /> : <LibraryView onOpen={setOpen} />}
              </>
            )}
          </>
        )}
      </SignInGate>
    </div>
  );
}