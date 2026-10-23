import { useEffect, useMemo, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { BackIcon, PauseIcon, PlayIcon, SearchIcon } from "@/ui/icons";
import { Toggle } from "@/features/settings/controls";
import { describeError, useLoad } from "../_sourcekit/api";
import { clock, dayLabel, SPEEDS, speedLabel, spoken } from "../_sourcekit/format";
import { Back15Icon, CheckIcon, Fwd30Icon } from "../_sourcekit/icons";
import { Art, Bar, Chips, IconButton, PageHeader, Problem, SignInGate, joinFacts, LoadingRows } from "../_sourcekit/ui";
import { episodeIdOf, episodeToTrack, fetchEpisodes, previewShow, searchDirectory, stateOf, usePodcasts, type DirectoryHit, type Episode, type Show } from "./podcastStore";

type Tab = "new" | "shows" | "find";

function EpisodeRow({ episode, showShow = true }: { episode: Episode; showShow?: boolean }) {
  const track = useMemo(() => episodeToTrack(episode), [episode]);
  const current = usePlayer((s) => s.current?.id === track.id);
  const playing = usePlayer((s) => s.isPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const playQueue = usePlayer((s) => s.playQueue);
  const local = usePodcasts((s) => s.progress);
  const setPlayed = usePodcasts((s) => s.setPlayed);
  const { position, played } = stateOf(episode, local);
  const play = () => (current ? toggle() : void playQueue([track], 0));
  const left = episode.durationSec > 0 && position > 0 && !played ? episode.durationSec - position : 0;
  return (
    <div className={`sk-row${current ? " current" : ""}`} style={{ opacity: played && !current ? 0.6 : 1 }}>
      <Art src={track.artwork} seed={episode.feedTitle ?? episode.title} label={episode.title} />
      <button className="sk-main" onClick={play} aria-label={`${current && playing ? "Pause" : "Play"} ${episode.title}`}>
        <span className="sk-title">{episode.title}</span>
        <span className="sk-sub">
          {joinFacts([showShow && episode.feedTitle, dayLabel(episode.publishedAt), left > 0 ? `${spoken(left)} left` : spoken(episode.durationSec), played && "Played"])}
        </span>
        <Bar position={played ? 0 : position} duration={episode.durationSec} label={`Progress of ${episode.title}`} />
      </button>
      <span className="sk-actions">
        <IconButton label={played ? `Mark ${episode.title} as not played` : `Mark ${episode.title} as played`} pressed={played} onClick={() => void setPlayed(episode.id, !played)}>
          <CheckIcon size={18} />
        </IconButton>
        <IconButton label={current && playing ? `Pause ${episode.title}` : `Play ${episode.title}`} onClick={play}>
          {current && playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
        </IconButton>
      </span>
    </div>
  );
}

/** Controls for what's playing: speed (remembered per show), skip back and forward, mark played. */
function NowListening() {
  const current = usePlayer((s) => s.current);
  const playing = usePlayer((s) => s.isPlaying);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const toggle = usePlayer((s) => s.toggle);
  const seek = usePlayer((s) => s.seek);
  const next = usePlayer((s) => s.next);
  const rate = usePodcasts((s) => s.rate);
  const changeSpeed = usePodcasts((s) => s.changeSpeed);
  const setPlayed = usePodcasts((s) => s.setPlayed);
  const id = current ? episodeIdOf(current) : null;
  if (!current || !id) return null;
  return (
    <section className="sk-now" aria-label="Now listening">
      <div className="sk-now-top">
        <Art src={current.artwork} seed={current.album ?? current.title} label={current.title} size={56} />
        <div style={{ minWidth: 0 }}>
          <span className="sk-title">{current.title}</span>
          <span className="sk-sub">{joinFacts([current.album, `${clock(position)} / ${clock(duration)}`])}</span>
        </div>
      </div>
      <Bar position={position} duration={duration} label="Episode progress" />
      <div className="sk-now-controls">
        <IconButton label="Back 15 seconds" onClick={() => seek(Math.max(0, position - 15))}>
          <Back15Icon size={24} />
        </IconButton>
        <IconButton label={playing ? "Pause" : "Play"} onClick={toggle}>
          {playing ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
        </IconButton>
        <IconButton label="Forward 30 seconds" onClick={() => seek(Math.min(duration || position + 30, position + 30))}>
          <Fwd30Icon size={24} />
        </IconButton>
        <button
          className="sk-pill"
          onClick={() => {
            void setPlayed(id, true);
            void next();
          }}
        >
          Mark played
        </button>
      </div>
      <div className="sk-chips" role="radiogroup" aria-label="Playback speed (remembered for this show)">
        {SPEEDS.map((s) => (
          <button key={s} role="radio" aria-checked={Math.abs(rate - s) < 0.01} className={`sk-pill${Math.abs(rate - s) < 0.01 ? " on" : ""}`} onClick={() => void changeSpeed(s)}>
            {speedLabel(s)}
          </button>
        ))}
      </div>
    </section>
  );
}

function ShowDetail({ show: initial, onBack }: { show: Show; onBack: () => void }) {
  const shows = usePodcasts((s) => s.shows);
  const subscribe = usePodcasts((s) => s.subscribe);
  const unsubscribe = usePodcasts((s) => s.unsubscribe);
  const setSpeed = usePodcasts((s) => s.setShowSpeed);
  const setAuto = usePodcasts((s) => s.setAutoQueue);
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [more, setMore] = useState<Episode[]>([]);
  const [busy, setBusy] = useState(false);
  const mine = shows.find((s) => s.id === initial.id);
  const show = mine ?? initial;
  const first = useLoad(() => fetchEpisodes(initial.id, { order }), `${initial.id}|${order}`, "podcasts");
  useEffect(() => setMore([]), [initial.id, order]);
  const items = [...(first.data?.items ?? []), ...more];
  const total = first.data?.total ?? 0;

  async function showMore() {
    setBusy(true);
    try {
      const page = await fetchEpisodes(initial.id, { order, offset: items.length });
      setMore((m) => [...m, ...page.items]);
    } catch {
      // The button stays; trying again is fine.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn ghost" onClick={onBack} style={{ minHeight: 44, marginBottom: 12 }}>
        <BackIcon size={16} /> Back
      </button>
      <div className="sk-detail-head">
        <Art src={show.image} seed={show.title} label={show.title} size={96} />
        <div style={{ minWidth: 0 }}>
          <h2>{show.title}</h2>
          <p className="sk-facts">{joinFacts([show.author, total ? `${total} episodes` : ""])}</p>
          <div className="sk-now-controls" style={{ marginTop: 8 }}>
            {mine ? (
              <button className="btn ghost" style={{ minHeight: 44 }} onClick={() => void unsubscribe(show.id)}>
                Unsubscribe
              </button>
            ) : (
              <button
                className="btn primary"
                style={{ minHeight: 44 }}
                disabled={busy || !initial.feedUrl}
                onClick={() => {
                  setBusy(true);
                  void subscribe(initial.feedUrl!).finally(() => setBusy(false));
                }}
              >
                Subscribe
              </button>
            )}
          </div>
        </div>
      </div>
      {mine && (
        <div className="sk-note stack" style={{ gap: 10 }}>
          <label className="row" style={{ justifyContent: "space-between", gap: 12, minHeight: 44 }}>
            <span>Playback speed for this show</span>
            <select className="sk-select" value={String(mine.speed ?? 1)} onChange={(e) => void setSpeed(mine.id, Number(e.target.value))} aria-label="Playback speed for this show">
              {[0.8, 1, 1.2, 1.5, 1.75, 2].map((s) => (
                <option key={s} value={s}>
                  {speedLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <div className="row" style={{ justifyContent: "space-between", gap: 12, minHeight: 44 }}>
            <span>Play the next episode automatically</span>
            <Toggle on={mine.autoQueue ?? true} onChange={(on) => void setAuto(mine.id, on)} label="Queue the next episodes of this show" />
          </div>
        </div>
      )}
      {show.description && <p className="sk-text">{show.description}</p>}
      <div className="sk-toolbar" style={{ marginTop: 16 }}>
        <Chips
          label="Episode order"
          value={order}
          onChange={setOrder}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]}
        />
      </div>
      <Problem message={first.error} onRetry={first.reload} />
      <div className="sk-list" role="list">
        {items.map((e) => (
          <EpisodeRow key={e.id} episode={e} showShow={false} />
        ))}
      </div>
      {first.loading && <LoadingRows label="Loading episodes…" />}
      {!first.loading && !first.error && items.length === 0 && <p className="empty">No episodes yet.</p>}
      {items.length > 0 && items.length < total && (
        <button className="btn ghost show-more" disabled={busy} onClick={() => void showMore()}>
          Show more ({total - items.length} left)
        </button>
      )}
    </>
  );
}

function NewView({ onOpen }: { onOpen: (s: Show) => void }) {
  const fresh = usePodcasts((s) => s.fresh);
  const loaded = usePodcasts((s) => s.freshLoaded);
  const shows = usePodcasts((s) => s.shows);
  const showsLoaded = usePodcasts((s) => s.showsLoaded);
  const refresh = usePodcasts((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  return (
    <>
      <div className="sk-toolbar">
        <button
          className="btn ghost"
          style={{ minHeight: 44 }}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void refresh()
              .then((r) => setNote(r ? (r.newEpisodes ? `${r.newEpisodes} new episode${r.newEpisodes === 1 ? "" : "s"}` : "You're up to date") : ""))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Checking…" : "Check for new episodes"}
        </button>
        <span className="sk-sub" role="status">
          {note}
        </span>
      </div>
      <div className="sk-list" role="list">
        {fresh.map((e) => (
          <EpisodeRow key={e.id} episode={e} />
        ))}
      </div>
      {!loaded && <LoadingRows label="Loading…" />}
      {loaded && fresh.length === 0 && showsLoaded && (
        <p className="empty">{shows.length === 0 ? "Subscribe to a show and its new episodes will show up here." : "Nothing new. You've heard it all."}</p>
      )}
      {shows.length > 0 && fresh.length === 0 && loaded && (
        <button className="btn ghost" style={{ minHeight: 44 }} onClick={() => onOpen(shows[0])}>
          Browse your shows
        </button>
      )}
    </>
  );
}

function ShowsView({ onOpen }: { onOpen: (s: Show) => void }) {
  const shows = usePodcasts((s) => s.shows);
  const loaded = usePodcasts((s) => s.showsLoaded);
  return (
    <>
      <div className="sk-grid">
        {shows.map((s) => (
          <button key={s.id} className="sk-tile" onClick={() => onOpen(s)} aria-label={`${s.title}${s.unplayed ? `, ${s.unplayed} unplayed` : ""}`}>
            <Art src={s.image} seed={s.title} label={s.title} />
            <span className="sk-title">{s.title}</span>
            <span className="sk-sub">{joinFacts([s.author, s.unplayed ? `${s.unplayed} unplayed` : ""])}</span>
          </button>
        ))}
      </div>
      {!loaded && <LoadingRows label="Loading your shows…" />}
      {loaded && shows.length === 0 && <p className="empty">You aren't subscribed to anything yet. Use Find to search, or paste a feed address.</p>}
    </>
  );
}

function FindView({ onOpen }: { onOpen: (s: Show) => void }) {
  const subscribe = usePodcasts((s) => s.subscribe);
  const [q, setQ] = useState("");
  const [feed, setFeed] = useState("");
  const [state, setState] = useState<{ items: DirectoryHit[]; source: string; loading: boolean; error: string | null; searched: boolean }>({ items: [], source: "", loading: false, error: null, searched: false });
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  async function search() {
    const term = q.trim();
    if (!term) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await searchDirectory(term);
      setState({ items: res.items, source: res.source, loading: false, error: null, searched: true });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: describeError(e, "podcasts"), searched: true }));
    }
  }

  async function add(url: string) {
    setAdding(url);
    setAddError(null);
    const show = await subscribe(url);
    setAdding(null);
    if (show) onOpen({ ...show, subscribed: true });
    else setAddError(usePodcasts.getState().error ?? "Couldn't add that show.");
  }

  async function open(hit: DirectoryHit) {
    try {
      const show = await previewShow(hit.feedUrl);
      onOpen({ ...show, feedUrl: hit.feedUrl });
    } catch (e) {
      setAddError(describeError(e, "podcasts"));
    }
  }

  return (
    <>
      <form
        className="sk-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="search-bar">
          <SearchIcon size={18} />
          <input placeholder="Search for a podcast…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search podcasts" />
        </div>
        <button className="btn primary" type="submit" style={{ minHeight: 44 }} disabled={state.loading || !q.trim()}>
          Search
        </button>
      </form>
      <Problem message={state.error} onRetry={() => void search()} />
      <div className="sk-list" role="list">
        {state.items.map((h) => (
          <div className="sk-row" key={h.feedUrl}>
            <Art src={h.image} seed={h.title} label={h.title} />
            <button className="sk-main" onClick={() => void open(h)} aria-label={`Open ${h.title}`}>
              <span className="sk-title">{h.title}</span>
              <span className="sk-sub">{h.author}</span>
            </button>
            <span className="sk-actions">
              {h.subscribed ? (
                <span className="sk-sub">Subscribed</span>
              ) : (
                <button className="sk-pill" disabled={adding === h.feedUrl} onClick={() => void add(h.feedUrl)} aria-label={`Subscribe to ${h.title}`}>
                  {adding === h.feedUrl ? "Adding…" : "Subscribe"}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      {state.loading && <LoadingRows label="Searching…" />}
      {state.searched && !state.loading && !state.error && state.items.length === 0 && <p className="empty">No podcasts found.</p>}
      {state.source && <p className="sk-sub">Results from {state.source === "podcastindex" ? "Podcast Index" : "Apple's iTunes Search"}.</p>}
      <p className="sk-section">Add by address</p>
      <form
        className="sk-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (feed.trim()) void add(feed.trim()).then(() => setFeed(""));
        }}
      >
        <input className="sk-field" placeholder="https://example.com/feed.xml" value={feed} onChange={(e) => setFeed(e.target.value)} aria-label="Podcast feed address" inputMode="url" autoCapitalize="off" autoCorrect="off" />
        <button className="btn" type="submit" style={{ minHeight: 44 }} disabled={!feed.trim() || adding !== null}>
          Add
        </button>
      </form>
      <Problem message={addError} />
    </>
  );
}

export function PodcastsPage() {
  const [tab, setTab] = useState<Tab>("new");
  const [open, setOpen] = useState<Show | null>(null);
  const error = usePodcasts((s) => s.error);
  const loaded = usePodcasts((s) => s.showsLoaded);
  const load = usePodcasts((s) => s.loadShows);
  const loadFresh = usePodcasts((s) => s.loadFresh);
  useEffect(() => {
    if (!loaded) {
      void load();
      void loadFresh();
    }
  }, [loaded, load, loadFresh]);
  return (
    <div className="view">
      <PageHeader title="Podcasts">Subscribe by search or feed address. Your place in every episode follows you between devices.</PageHeader>
      <SignInGate what="Podcasts">
        <NowListening />
        {open ? (
          <ShowDetail show={open} onBack={() => setOpen(null)} />
        ) : (
          <>
            <div className="sk-toolbar">
              <Chips
                label="Podcast sections"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "new", label: "New" },
                  { value: "shows", label: "Shows" },
                  { value: "find", label: "Find" },
                ]}
              />
            </div>
            <Problem message={error} onRetry={() => void load()} />
            {tab === "new" ? <NewView onOpen={setOpen} /> : tab === "shows" ? <ShowsView onOpen={setOpen} /> : <FindView onOpen={setOpen} />}
          </>
        )}
      </SignInGate>
    </div>
  );
}