import { useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "@/app/navStore";
import { CoverArt } from "@/ui/CoverArt";
import { primaryArtist } from "@/shared/types";
import { Notice, Page, Stat, Tabs } from "../_social/ui";
import { useSignedIn } from "../_social/serverApi";
import { copyImage, downloadBlob, safeFileName, shareImage } from "../_social/canvasCard";
import { renderSummaryCard } from "./card";
import {
  aggregate,
  formatHours,
  headline,
  makeRanges,
  peakHour,
  peakWeekday,
  weekdayName,
  yearsWithPlays,
  type Stats,
} from "./stats";
import { useStatsData } from "./statsStore";
import "./style.css";

export const STATS_ITEM_ID = "stats-wrapped";

function Bars({ values, labels, unit, highlight }: { values: number[]; labels: (i: number) => string; unit: (v: number) => string; highlight?: number }) {
  const max = Math.max(1, ...values);
  return (
    <div className="sw-bars" role="img" aria-label={values.map((v, i) => `${labels(i)}: ${unit(v)}`).join(", ")}>
      {values.map((v, i) => (
        <div key={i} className={`sw-bar-col${i === highlight ? " peak" : ""}`} title={`${labels(i)}: ${unit(v)}`}>
          <div className="sw-bar-track">
            <div className="sw-bar-fill" style={{ height: `${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%` }} />
          </div>
          <span className="sw-bar-label">{labels(i)}</span>
        </div>
      ))}
    </div>
  );
}

function RankList({ items }: { items: { key: string; title: string; sub?: string; count: number; art?: { src?: string; seed: string } }[] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <p className="muted small">Nothing yet.</p>;
  return (
    <ol className="sx-list sw-rank">
      {items.map((it, i) => (
        <li key={it.key}>
          <span className="sx-rank">{i + 1}</span>
          {it.art && (
            <span className="sx-thumb">
              <CoverArt src={it.art.src} seed={it.art.seed} label={it.title} showInitial={false} />
            </span>
          )}
          <span className="sx-grow">
            <span className="sx-title" style={{ display: "block" }}>
              {it.title}
            </span>
            {it.sub && <span className="sx-sub" style={{ display: "block" }}>{it.sub}</span>}
            <span className="sx-bar" style={{ display: "block", marginTop: 4 }}>
              <span style={{ width: `${(it.count / max) * 100}%` }} />
            </span>
          </span>
          <span className="muted small sw-count">{it.count}</span>
        </li>
      ))}
    </ol>
  );
}

function ShareSection({ stats, label, onClose }: { stats: Stats; label: string; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filename = safeFileName(`cadence-${label}`, "png");
  const sectionRef = useRef<HTMLElement>(null);

  // The card opens below the summary; on a phone that is off screen, so bring it into view.
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    sectionRef.current?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, []);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setBlob(null);
    setError(null);
    renderSummaryCard(stats, label)
      .then(async (b) => {
        if (cancelled) return;
        revoked = URL.createObjectURL(b);
        setBlob(b);
        setUrl(revoked);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [stats, label]);

  const share = async () => {
    if (!blob) return;
    const result = await shareImage(blob, filename, `My ${label} on Cadence`, `My listening in ${label}`);
    if (result === "unsupported") setMessage("Sharing isn't available here. Download the image instead.");
    else if (result === "shared") setMessage("Shared.");
  };
  const copy = async () => {
    if (!blob) return;
    setMessage((await copyImage(blob)) ? "Copied to the clipboard." : "Copying images isn't supported here. Download it instead.");
  };

  return (
    <section ref={sectionRef} className="sx-card sw-share" aria-label="Shareable summary card">
      <div className="sx-row" style={{ justifyContent: "space-between" }}>
        <h2>Shareable card</h2>
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {url ? <img className="sw-card-img" src={url} alt={`Summary card for ${label}`} /> : !error && <p className="muted">Drawing your card...</p>}
      <div className="sx-row">
        <button className="btn" disabled={!blob} onClick={() => blob && downloadBlob(blob, filename)}>
          Download
        </button>
        <button className="btn" disabled={!blob} onClick={() => void share()}>
          Share
        </button>
        <button className="btn" disabled={!blob} onClick={() => void copy()}>
          Copy image
        </button>
      </div>
      <p className="muted small" aria-live="polite">
        {message ?? "The card is drawn on your device. Nothing is uploaded."}
      </p>
    </section>
  );
}

export function StatsPage() {
  const { plays, status, error, source, truncated, load } = useStatsData();
  const [rangeId, setRangeId] = useState("30d");
  const [sharing, setSharing] = useState(false);

  const signedIn = useSignedIn();
  useEffect(() => {
    void load();
  }, [load, signedIn]);

  const now = useMemo(() => new Date(), []);
  const ranges = useMemo(() => makeRanges(now, yearsWithPlays(plays)), [now, plays]);
  const range = ranges.find((r) => r.id === rangeId) ?? ranges[1];
  const stats = useMemo(() => aggregate(plays, range, now.getTime()), [plays, range, now]);
  const isYear = /^y\d{4}$/.test(range.id);
  const label = isYear ? range.id.slice(1) : range.label;

  const peakDay = stats.secondsByWeekday.indexOf(Math.max(...stats.secondsByWeekday));
  const peakH = stats.secondsByHour.indexOf(Math.max(...stats.secondsByHour));

  return (
    <Page
      title="Listening stats"
      subtitle={source === "server" ? "From your listening history on this server, across all your devices." : "From this device only. Sign in to a Cadence server to include your other devices."}
      actions={
        <button className="btn" disabled={stats.plays === 0} onClick={() => setSharing(true)}>
          Share card
        </button>
      }
    >
      {error && <Notice kind="warn">Couldn't load your server history ({error}). Showing this device only.</Notice>}
      {truncated && <Notice>Only your most recent plays were loaded, so older totals may be low.</Notice>}

      <div className="sw-ranges">
        <Tabs
          label="Time range"
          value={range.id}
          onChange={(id) => {
            setRangeId(id);
            setSharing(false);
          }}
          options={ranges.map((r) => ({ id: r.id, label: r.label }))}
        />
      </div>

      {status === "loading" && plays.length === 0 ? (
        <p className="muted">Loading your history...</p>
      ) : stats.plays === 0 ? (
        <div className="sx-card">
          <p>No listening in {range.label.toLowerCase()} yet.</p>
          <p className="muted small">Plays are recorded as you listen. Pick another range or come back after a few songs.</p>
        </div>
      ) : (
        <div className="sx-stack">
          <section className="sx-card sw-hero" aria-label={isYear ? `Your ${label} in review` : "Summary"}>
            <div className="eyebrow">{isYear ? `Your ${label} in review` : range.label}</div>
            <div className="sw-hero-number">{formatHours(stats.seconds)}</div>
            <p className="muted">{headline(stats)}</p>
            {isYear && stats.topArtists[0] && (
              <p>
                Your year belonged to <strong>{stats.topArtists[0].name}</strong>, with {stats.topArtists[0].plays} plays
                {stats.topTracks[0] ? <>, led by <strong>{stats.topTracks[0].track.title}</strong></> : null}.
              </p>
            )}
          </section>

          {sharing && <ShareSection stats={stats} label={label} onClose={() => setSharing(false)} />}

          <div className="sx-stats">
            <Stat value={stats.plays.toLocaleString()} label="Plays" />
            <Stat value={stats.uniqueTracks.toLocaleString()} label="Different songs" />
            <Stat value={stats.uniqueArtists.toLocaleString()} label="Artists" />
            <Stat value={formatHours(stats.seconds)} label="Listening time" hint="Estimated from song lengths" />
          </div>

          <div className="sx-grid">
            <section className="sx-card">
              <h2>Top artists</h2>
              <RankList items={stats.topArtists.map((a) => ({ key: a.name, title: a.name, sub: formatHours(a.seconds), count: a.plays }))} />
            </section>
            <section className="sx-card">
              <h2>Top songs</h2>
              <RankList
                items={stats.topTracks.map((t) => ({
                  key: t.track.id,
                  title: t.track.title,
                  sub: primaryArtist(t.track),
                  count: t.plays,
                  art: { src: t.track.artwork, seed: t.track.album ?? t.track.title },
                }))}
              />
            </section>
            <section className="sx-card">
              <h2>Top albums</h2>
              <RankList
                items={stats.topAlbums.map((a) => ({ key: `${a.album}|${a.artist}`, title: a.album, sub: a.artist, count: a.plays, art: { src: a.artwork, seed: a.album } }))}
              />
            </section>
          </div>

          <div className="sx-grid">
            <section className="sx-card">
              <h2>By day of the week</h2>
              <Bars
                values={stats.secondsByWeekday}
                labels={(i) => weekdayName(i)}
                unit={(v) => formatHours(v)}
                highlight={stats.secondsByWeekday[peakDay] > 0 ? peakDay : undefined}
              />
              {peakWeekday(stats.secondsByWeekday) && <p className="muted small">Busiest: {peakWeekday(stats.secondsByWeekday)}.</p>}
            </section>
            <section className="sx-card">
              <h2>By time of day</h2>
              <Bars
                values={stats.secondsByHour}
                labels={(i) => (i % 6 === 0 ? String(i) : "")}
                unit={(v) => formatHours(v)}
                highlight={stats.secondsByHour[peakH] > 0 ? peakH : undefined}
              />
              {peakHour(stats.secondsByHour) && <p className="muted small">Most active around {peakHour(stats.secondsByHour)}.</p>}
            </section>
          </div>

          <div className="sx-grid">
            <section className="sx-card">
              <h2>Habits</h2>
              <div className="sx-stats">
                <Stat value={stats.streaks.current} label="Current streak" hint="days in a row" />
                <Stat value={stats.streaks.longest} label="Longest streak" hint="days in a row" />
                <Stat value={stats.streaks.activeDays} label="Days with music" />
              </div>
              {stats.busiestDay && (
                <p className="muted small" style={{ marginTop: 10 }}>
                  Busiest day: {new Date(`${stats.busiestDay.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} with {stats.busiestDay.plays} plays.
                </p>
              )}
            </section>
            <section className="sx-card">
              <h2>New and familiar</h2>
              <div className="sw-split" role="img" aria-label={`${Math.round(stats.newVsRepeat.newShare * 100)} percent of plays were songs new to you`}>
                <span style={{ width: `${stats.newVsRepeat.newShare * 100}%` }} />
              </div>
              <p className="small" style={{ marginTop: 10 }}>
                <strong>{Math.round(stats.newVsRepeat.newShare * 100)}%</strong> of plays were songs new to you ({stats.newVsRepeat.newTracks} songs), the rest were
                replays of things you already knew.
              </p>
            </section>
          </div>
        </div>
      )}
    </Page>
  );
}

/** Small summary for Home: the last 7 days at a glance. */
export function StatsWidget() {
  const { plays, load } = useStatsData();
  const navigate = useNav((s) => s.navigate);
  const signedIn = useSignedIn();
  useEffect(() => {
    void load();
  }, [load, signedIn]);
  const stats = useMemo(() => {
    const now = new Date();
    const week = makeRanges(now, [])[0];
    return aggregate(plays, week, now.getTime(), 3);
  }, [plays]);
  if (stats.plays === 0) return <p className="muted small">Your listening stats appear here after a few plays.</p>;
  return (
    <div className="sw-widget">
      <div className="sx-stats">
        <Stat value={formatHours(stats.seconds)} label="This week" />
        <Stat value={stats.topArtists[0]?.name ?? "-"} label="Top artist" />
        <Stat value={stats.streaks.current} label="Day streak" />
      </div>
      <button className="btn ghost" onClick={() => navigate({ kind: "plugin", itemId: STATS_ITEM_ID })}>
        See all stats
      </button>
    </div>
  );
}

