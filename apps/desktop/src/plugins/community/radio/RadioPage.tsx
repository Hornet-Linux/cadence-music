import { useEffect, useMemo, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { HeartIcon, PauseIcon, PlayIcon, SearchIcon } from "@/ui/icons";
import { describeError, useDebounced } from "../_sourcekit/api";
import { Art, Chips, IconButton, PageHeader, Problem, SignInGate } from "../_sourcekit/ui";
import { describeStation, fetchFacets, fetchStations, isFavourite, stationIdOf, stationToTrack, useRadio, type Facet, type RadioStation } from "./radioStore";

type Tab = "favourites" | "top" | "trending" | "search";
const PAGE = 30;

function StationRow({ station, queue, index }: { station: RadioStation; queue: RadioStation[]; index: number }) {
  const track = useMemo(() => stationToTrack(station), [station]);
  const current = usePlayer((s) => s.current?.id === track.id);
  const playing = usePlayer((s) => s.isPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const playQueue = usePlayer((s) => s.playQueue);
  const favs = useRadio((s) => s.favourites);
  const toggleFavourite = useRadio((s) => s.toggleFavourite);
  const fav = isFavourite(favs, station.id);
  const play = () => (current ? toggle() : void playQueue(queue.map(stationToTrack), index));
  return (
    <div className={`sk-row${current ? " current" : ""}`}>
      <Art src={track.artwork} seed={station.name} label={station.name} />
      <button className="sk-main" onClick={play} aria-label={`${current && playing ? "Pause" : "Play"} ${station.name}`}>
        <span className="sk-title">{station.name}</span>
        <span className="sk-sub">{describeStation(station)}</span>
      </button>
      <span className="sk-actions">
        <IconButton label={fav ? `Remove ${station.name} from favourites` : `Add ${station.name} to favourites`} pressed={fav} onClick={() => void toggleFavourite(station)}>
          <HeartIcon size={18} filled={fav} />
        </IconButton>
        <IconButton label={current && playing ? `Pause ${station.name}` : `Play ${station.name}`} onClick={play}>
          {current && playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
        </IconButton>
      </span>
    </div>
  );
}

/** What the station is playing right now (its ICY "StreamTitle"), above the lists. */
function NowPlayingCard() {
  const current = usePlayer((s) => s.current);
  const playing = usePlayer((s) => s.isPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const np = useRadio((s) => s.nowPlaying);
  const id = current ? stationIdOf(current) : null;
  if (!current || !id) return null;
  const title = np?.stationId === id ? np.title : null;
  return (
    <section className="sk-now" aria-label="Now playing on the radio">
      <div className="sk-now-top">
        <Art src={current.artwork} seed={current.title} label={current.title} size={56} />
        <div style={{ minWidth: 0 }}>
          <span className="sk-sub">{playing ? "Listening to" : "Paused on"}</span>
          <span className="sk-title">{current.title}</span>
          <span className="sk-sub" aria-live="polite" data-testid="icy-title">
            {title ?? "No song information from this station"}
          </span>
        </div>
      </div>
      <div className="sk-now-controls">
        <button className="btn primary" onClick={toggle} style={{ minHeight: 44 }}>
          {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />} {playing ? "Pause" : "Play"}
        </button>
      </div>
    </section>
  );
}

function useFacets(enabled: boolean) {
  const [facets, setFacets] = useState<{ countries: Facet[]; languages: Facet[]; tags: Facet[] }>({ countries: [], languages: [], tags: [] });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void Promise.all([fetchFacets("countries"), fetchFacets("languages"), fetchFacets("tags")])
      .then(([countries, languages, tags]) => live && setFacets({ countries, languages, tags }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled]);
  return facets;
}

function Browse({ tab }: { tab: "top" | "trending" | "search" }) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [language, setLanguage] = useState("");
  const [tag, setTag] = useState("");
  const debounced = useDebounced(name.trim(), 350);
  const facets = useFacets(tab === "search");
  const [state, setState] = useState<{ items: RadioStation[]; hasMore: boolean; loading: boolean; error: string | null }>({ items: [], hasMore: false, loading: true, error: null });
  const [retry, setRetry] = useState(0);
  const key = `${tab}|${debounced}|${country}|${language}|${tag}|${retry}`;
  const filtered = tab === "search" && !debounced && !country && !language && !tag;

  useEffect(() => {
    let live = true;
    if (filtered) {
      setState({ items: [], hasMore: false, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, items: [], loading: true, error: null }));
    fetchStations({ mode: tab, name: debounced, country, language, tag, limit: PAGE })
      .then((page) => live && setState({ items: page.items, hasMore: page.hasMore, loading: false, error: null }))
      .catch((e: unknown) => live && setState({ items: [], hasMore: false, loading: false, error: describeError(e, "internet radio") }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function more() {
    setState((s) => ({ ...s, loading: true }));
    try {
      const page = await fetchStations({ mode: tab, name: debounced, country, language, tag, limit: PAGE, offset: state.items.length });
      setState((s) => ({ items: [...s.items, ...page.items.filter((p) => !s.items.some((x) => x.id === p.id))], hasMore: page.hasMore, loading: false, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: describeError(e, "internet radio") }));
    }
  }

  return (
    <>
      {tab === "search" && (
        <>
          <div className="sk-toolbar">
            <div className="search-bar">
              <SearchIcon size={18} />
              <input placeholder="Station name…" value={name} onChange={(e) => setName(e.target.value)} aria-label="Search stations by name" />
            </div>
          </div>
          <div className="sk-toolbar">
            <select className="sk-select" value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country">
              <option value="">Any country</option>
              {facets.countries.map((c) => (
                <option key={c.name} value={c.code ?? c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select className="sk-select" value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">
              <option value="">Any language</option>
              {facets.languages.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
            <select className="sk-select" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Genre or tag">
              <option value="">Any genre</option>
              {facets.tags.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      <Problem message={state.error} onRetry={() => setRetry((n) => n + 1)} />
      <div className="sk-list" role="list">
        {state.items.map((s, i) => (
          <StationRow key={s.id} station={s} queue={state.items} index={i} />
        ))}
      </div>
      {state.loading && <p className="empty">Loading stations…</p>}
      {filtered && <p className="empty">Search by name, or pick a country, language or genre.</p>}
      {!state.loading && !state.error && !filtered && state.items.length === 0 && <p className="empty">No stations found.</p>}
      {!state.loading && state.hasMore && (
        <button className="btn ghost show-more" onClick={() => void more()}>
          Show more
        </button>
      )}
    </>
  );
}

function Favourites() {
  const favs = useRadio((s) => s.favourites);
  const loaded = useRadio((s) => s.favouritesLoaded);
  const error = useRadio((s) => s.error);
  const load = useRadio((s) => s.loadFavourites);
  return (
    <>
      <Problem message={error} onRetry={() => void load()} />
      <div className="sk-list" role="list">
        {favs.map((s, i) => (
          <StationRow key={s.id} station={s} queue={favs} index={i} />
        ))}
      </div>
      {!loaded && <p className="empty">Loading your stations…</p>}
      {loaded && !error && favs.length === 0 && <p className="empty">No favourite stations yet. Tap the heart on a station to keep it here.</p>}
    </>
  );
}

export function RadioPage() {
  const [tab, setTab] = useState<Tab>("favourites");
  const loaded = useRadio((s) => s.favouritesLoaded);
  const favCount = useRadio((s) => s.favourites.length);
  const load = useRadio((s) => s.loadFavourites);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    // With no favourites yet, start on what's popular.
    if (loaded && favCount === 0) setTab((t) => (t === "favourites" ? "top" : t));
    // Only decide once, when the favourites first arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  return (
    <div className="view">
      <PageHeader title="Radio">Live stations from the Radio Browser community directory, played through your server.</PageHeader>
      <SignInGate what="Internet radio">
        <NowPlayingCard />
        <div className="sk-toolbar">
          <Chips
            label="Radio sections"
            value={tab}
            onChange={setTab}
            options={[
              { value: "favourites", label: "Favourites" },
              { value: "top", label: "Top" },
              { value: "trending", label: "Trending" },
              { value: "search", label: "Search" },
            ]}
          />
        </div>
        {tab === "favourites" ? <Favourites /> : <Browse key={tab} tab={tab} />}
      </SignInGate>
    </div>
  );
}

