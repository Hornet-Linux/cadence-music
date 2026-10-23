import { useEffect, useMemo, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { BackIcon, PauseIcon, PlayIcon, SearchIcon } from "@/ui/icons";
import { serverUrl, useDebounced, useLoad } from "../_sourcekit/api";
import { clock, spoken } from "../_sourcekit/format";
import { Art, Chips, IconButton, PageHeader, Problem, SignInGate, joinFacts, LoadingRows } from "../_sourcekit/ui";
import { detailToTracks, fetchArchiveItem, fetchBands, searchArchive, yearOf, type ArchiveDetail, type ArchiveItem } from "./archiveStore";

type Tab = "live" | "audio";
type View = { kind: "home" } | { kind: "band"; band: ArchiveItem } | { kind: "show"; item: ArchiveItem };

const num = (n: number) => n.toLocaleString();

function ItemRow({ item, onOpen, showCreator = true }: { item: ArchiveItem; onOpen: (i: ArchiveItem) => void; showCreator?: boolean }) {
  return (
    <div className="sk-row">
      <Art src={serverUrl(item.cover)} seed={item.title} label={item.title} />
      <button className="sk-main" onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}>
        <span className="sk-title">{item.title}</span>
        <span className="sk-sub">{joinFacts([showCreator && item.creator, item.date ?? yearOf(item), item.licence, item.downloads ? `${num(item.downloads)} plays` : ""])}</span>
      </button>
      <span className="sk-actions" aria-hidden />
    </div>
  );
}

function Results({ load, keyOf, onOpen, empty, showCreator }: { load: (page: number) => Promise<{ items: ArchiveItem[]; hasMore: boolean }>; keyOf: string; onOpen: (i: ArchiveItem) => void; empty: string; showCreator?: boolean }) {
  const first = useLoad(() => load(1), keyOf, "the Internet Archive");
  const [more, setMore] = useState<{ items: ArchiveItem[]; hasMore: boolean; page: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setMore(null), [keyOf]);
  const items = [...(first.data?.items ?? []), ...(more?.items ?? [])];
  const hasMore = more ? more.hasMore : (first.data?.hasMore ?? false);
  async function next() {
    setBusy(true);
    try {
      const page = (more?.page ?? 1) + 1;
      const res = await load(page);
      setMore({ items: [...(more?.items ?? []), ...res.items.filter((r) => !items.some((x) => x.id === r.id))], hasMore: res.hasMore, page });
    } catch {
      // The button stays for another try.
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Problem message={first.error} onRetry={first.reload} />
      <div className="sk-list" role="list">
        {items.map((i) => (
          <ItemRow key={i.id} item={i} onOpen={onOpen} showCreator={showCreator} />
        ))}
      </div>
      {first.loading && <LoadingRows label="Loading…" />}
      {!first.loading && !first.error && items.length === 0 && <p className="empty">{empty}</p>}
      {hasMore && (
        <button className="btn ghost show-more" disabled={busy} onClick={() => void next()}>
          Show more
        </button>
      )}
    </>
  );
}

function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className="sk-toolbar">
      <div className="search-bar">
        <SearchIcon size={18} />
        <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      </div>
    </div>
  );
}

function LiveMusic({ onOpen }: { onOpen: (v: View) => void }) {
  const [mode, setMode] = useState<"bands" | "shows">("bands");
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 350);
  return (
    <>
      <div className="sk-toolbar">
        <Chips
          label="Live Music Archive"
          value={mode}
          onChange={setMode}
          options={[
            { value: "bands", label: "Bands" },
            { value: "shows", label: "Search shows" },
          ]}
        />
      </div>
      <SearchBox value={q} onChange={setQ} placeholder={mode === "bands" ? "Find a band…" : "Search shows by band or title…"} label={mode === "bands" ? "Search bands" : "Search shows"} />
      {mode === "bands" ? (
        <Results key="bands" keyOf={`bands|${term}`} load={async (page) => { const r = await fetchBands(term, page); return { items: r.items, hasMore: r.items.length >= 40 }; }} onOpen={(band) => onOpen({ kind: "band", band })} empty="No bands found." showCreator={false} />
      ) : (
        <Results key="shows" keyOf={`shows|${term}`} load={(page) => searchArchive({ q: term, kind: "etree", page })} onOpen={(item) => onOpen({ kind: "show", item })} empty={term ? "No shows found." : "Type a band or title to search."} />
      )}
    </>
  );
}

function BandView({ band, onBack, onOpen }: { band: ArchiveItem; onBack: () => void; onOpen: (v: View) => void }) {
  const [year, setYear] = useState("");
  const [sort, setSort] = useState<"downloads" | "date" | "oldest">("downloads");
  const validYear = /^\d{4}$/.test(year) ? year : "";
  return (
    <>
      <button className="btn ghost" onClick={onBack} style={{ minHeight: 44, marginBottom: 12 }}>
        <BackIcon size={16} /> Back
      </button>
      <h2 style={{ margin: "0 0 12px" }}>{band.title}</h2>
      <div className="sk-toolbar">
        <Chips
          label="Order"
          value={sort}
          onChange={setSort}
          options={[
            { value: "downloads", label: "Most played" },
            { value: "date", label: "Newest" },
            { value: "oldest", label: "Oldest" },
          ]}
        />
      </div>
      <div className="sk-toolbar">
        <input className="sk-field" style={{ maxWidth: 200 }} inputMode="numeric" maxLength={4} placeholder="Year, e.g. 1977" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))} aria-label="Only shows from this year" />
      </div>
      <Results keyOf={`${band.id}|${sort}|${validYear}`} load={(page) => searchArchive({ kind: "etree", collection: band.id, year: validYear, sort, page })} onOpen={(item) => onOpen({ kind: "show", item })} empty="No shows found." showCreator={false} />
    </>
  );
}

function ShowView({ item, onBack }: { item: ArchiveItem; onBack: () => void }) {
  const [format, setFormat] = useState<"mp3" | "ogg" | "flac">("mp3");
  const show = useLoad(() => fetchArchiveItem(item.id, format), `${item.id}|${format}`, "the Internet Archive");
  const d = show.data;
  return (
    <>
      <button className="btn ghost" onClick={onBack} style={{ minHeight: 44, marginBottom: 12 }}>
        <BackIcon size={16} /> Back
      </button>
      <Problem message={show.error} onRetry={show.reload} />
      {show.loading && !d && <LoadingRows label="Loading…" />}
      {d && <ShowBody d={d} format={format} onFormat={setFormat} />}
    </>
  );
}

function ShowBody({ d, format, onFormat }: { d: ArchiveDetail; format: "mp3" | "ogg" | "flac"; onFormat: (f: "mp3" | "ogg" | "flac") => void }) {
  const tracks = useMemo(() => detailToTracks(d), [d]);
  const playQueue = usePlayer((s) => s.playQueue);
  const toggle = usePlayer((s) => s.toggle);
  const currentId = usePlayer((s) => s.current?.id);
  const playing = usePlayer((s) => s.isPlaying);
  const total = d.tracks.reduce((n, t) => n + t.durationSec, 0);
  const a = d.attribution;
  return (
    <>
      <div className="sk-detail-head">
        <Art src={serverUrl(d.cover)} seed={d.title} label={d.title} size={96} />
        <div style={{ minWidth: 0 }}>
          <h2>{d.title}</h2>
          <p className="sk-facts">{joinFacts([d.creator, d.date, d.venue, d.coverage, spoken(total)])}</p>
          <div className="sk-now-controls" style={{ marginTop: 8 }}>
            <button className="btn primary" style={{ minHeight: 44 }} onClick={() => void playQueue(tracks, 0)} disabled={tracks.length === 0}>
              <PlayIcon size={16} /> Play all
            </button>
          </div>
        </div>
      </div>
      <div className="sk-note" aria-label="Attribution and licence">
        <strong>Attribution.</strong> {a.text}.{" "}
        <a href={a.detailsUrl} target="_blank" rel="noreferrer">
          View on the Internet Archive
        </a>
        {a.licence ? (
          <>
            {" "}
            · Licence:{" "}
            <a href={a.licence.url} target="_blank" rel="noreferrer">
              {a.licence.name}
            </a>
          </>
        ) : (
          <> · No licence is stated for this recording; the Archive page lists its terms.</>
        )}
        {a.rights ? <> · Rights: {a.rights}</> : null}
        {(d.taper || d.source) && (
          <>
            <br />
            {d.taper && <>Taper: {d.taper}. </>}
            {d.source && <>Source: {d.source}</>}
          </>
        )}
      </div>
      {d.formats.length > 1 && (
        <div className="sk-toolbar">
          <Chips label="Audio format" value={format} onChange={onFormat} options={d.formats.map((f) => ({ value: f, label: f === "mp3" ? "MP3" : f === "ogg" ? "Ogg" : "FLAC" }))} />
        </div>
      )}
      <div className="sk-list" role="list">
        {d.tracks.map((t, i) => {
          const track = tracks[i];
          const current = !!track && currentId === track.id;
          const play = () => (current ? toggle() : void playQueue(tracks, i));
          return (
            <div className={`sk-row${current ? " current" : ""}`} key={t.path} style={{ gridTemplateColumns: "28px minmax(0,1fr) auto" }}>
              <span className="sk-sub" style={{ textAlign: "right" }}>
                {t.track ?? i + 1}
              </span>
              <button className="sk-main" onClick={play} aria-label={`${current && playing ? "Pause" : "Play"} ${t.title}`}>
                <span className="sk-title">{t.title}</span>
                <span className="sk-sub">{joinFacts([clock(t.durationSec), t.format])}</span>
              </button>
              <span className="sk-actions">
                <IconButton label={current && playing ? `Pause ${t.title}` : `Play ${t.title}`} onClick={play}>
                  {current && playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
                </IconButton>
              </span>
            </div>
          );
        })}
      </div>
      {d.description && (
        <>
          <p className="sk-section">About this recording</p>
          <p className="sk-text">{d.description}</p>
        </>
      )}
    </>
  );
}

export function ArchivePage() {
  const [tab, setTab] = useState<Tab>("live");
  const [view, setView] = useState<View>({ kind: "home" });
  const [stack, setStack] = useState<View[]>([]);
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 350);
  const go = (v: View) => {
    setStack((s) => [...s, view]);
    setView(v);
  };
  const back = () => {
    setView(stack[stack.length - 1] ?? { kind: "home" });
    setStack((s) => s.slice(0, -1));
  };
  return (
    <div className="view">
      <PageHeader title="Internet Archive">Free recordings from archive.org, including the Live Music Archive. Every recording shows its licence.</PageHeader>
      <SignInGate what="The Internet Archive">
        {view.kind === "band" ? (
          <BandView band={view.band} onBack={back} onOpen={go} />
        ) : view.kind === "show" ? (
          <ShowView item={view.item} onBack={back} />
        ) : (
          <>
            <div className="sk-toolbar">
              <Chips
                label="Internet Archive sections"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "live", label: "Live Music" },
                  { value: "audio", label: "Audio" },
                ]}
              />
            </div>
            {tab === "live" ? (
              <LiveMusic onOpen={go} />
            ) : (
              <>
                <SearchBox value={q} onChange={setQ} placeholder="Search audio on the Archive…" label="Search the Internet Archive" />
                <Results keyOf={`audio|${term}`} load={(page) => searchArchive({ q: term, kind: "audio", page })} onOpen={(item) => go({ kind: "show", item })} empty="Nothing found." />
              </>
            )}
          </>
        )}
      </SignInGate>
    </div>
  );
}