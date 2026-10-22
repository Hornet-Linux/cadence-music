import { useEffect, useRef, useState } from "react";
import { usePlayer } from "@/player/playerStore";
import { formatDuration } from "@/shared/types";
import { call, formatBytes, pluralize, send, useLoad, explainError } from "../_serverlib/api";
import { ErrorNotice, Gate, Page, Progress, Stat, Tabs, serverTrackToTrack } from "../_serverlib/ui";
import { FIELD_LABELS, type DuplicateGroup, type HealthReport, type HealthStatus } from "./types";

type Tab = "duplicates" | "artwork" | "tags" | "problems";
const PAGE = 40;

function DuplicateCard({ group }: { group: DuplicateGroup }) {
  const playQueue = usePlayer((s) => s.playQueue);
  return (
    <article className="card sl-item">
      <div>
        <span className="badge">{group.confidence === "exact" ? "Same audio" : "Probably the same"}</span>{" "}
        <span className="muted small">{group.reasons.join(", ")}</span>
        {!group.sameAlbum && <span className="muted small"> (different albums)</span>}
      </div>
      {group.tracks.map((t) => (
        <div key={t.id} className="sl-dup">
          <button
            className="icon-btn sl-play"
            aria-label={`Play ${t.title}`}
            onClick={() => void playQueue([serverTrackToTrack({ ...t, albumArtist: null })], 0)}
          >
            ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“Ãƒâ€šÃ‚Â¶
          </button>
          <div className="sl-dup-text">
            <h3>
              {t.title}
              {t.id === group.suggestedKeepId && <span className="sl-tag keep">best copy</span>}
            </h3>
            <div className="sl-path">{t.relPath}</div>
            <div className="muted small">
              {[
                t.codec,
                t.bitrate ? `${t.bitrate} kbps` : null,
                t.lossless ? "lossless" : null,
                formatBytes(t.size),
                formatDuration(t.durationSec ?? undefined),
              ]
                .filter(Boolean)
                .join(" ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ")}
            </div>
          </div>
        </div>
      ))}
    </article>
  );
}

function Report({ report }: { report: HealthReport }) {
  const [tab, setTab] = useState<Tab>("duplicates");
  const [shown, setShown] = useState(PAGE);
  const s = report.summary;
  const choose = (t: Tab) => {
    setTab(t);
    setShown(PAGE);
  };
  const lists = {
    duplicates: report.duplicates,
    artwork: report.missingArtwork,
    tags: report.missingTags,
    problems: report.problems,
  };
  const total = {
    duplicates: s.duplicateGroups,
    artwork: s.missingArtworkAlbums,
    tags: s.tracksMissingTags,
    problems: s.unreadable + s.corrupt,
  };
  const current = lists[tab];
  const empty = current.length === 0;

  return (
    <>
      <div className="sl-stats">
        <Stat label="Tracks checked" value={`${s.indexed.toLocaleString()} / ${s.tracks.toLocaleString()}`} />
        <Stat label="Duplicate groups" value={s.duplicateGroups.toLocaleString()} tone={s.duplicateGroups ? "warn" : undefined} />
        <Stat label="Albums without artwork" value={s.missingArtworkAlbums.toLocaleString()} />
        <Stat label="Tracks missing tags" value={s.tracksMissingTags.toLocaleString()} />
        <Stat
          label="Unreadable or corrupt"
          value={(s.unreadable + s.corrupt).toLocaleString()}
          tone={s.unreadable + s.corrupt ? "warn" : undefined}
        />
      </div>
      <Tabs
        value={tab}
        onChange={choose}
        items={[
          { id: "duplicates", label: "Duplicates", count: total.duplicates },
          { id: "artwork", label: "Artwork", count: total.artwork },
          { id: "tags", label: "Tags", count: total.tags },
          { id: "problems", label: "Problems", count: total.problems },
        ]}
      />
      {empty && <p className="empty">Nothing to show here. That is good news.</p>}
      <div className="sl-list">
        {tab === "duplicates" &&
          report.duplicates.slice(0, shown).map((g) => <DuplicateCard key={g.tracks.map((t) => t.id).join()} group={g} />)}
        {tab === "artwork" &&
          report.missingArtwork.slice(0, shown).map((a) => (
            <article key={a.folder + (a.album ?? "")} className="card sl-item">
              <h3>{a.album ?? "(no album tag)"}</h3>
              <div className="muted small">
                {a.artist ?? "Unknown artist"} ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· {pluralize(a.tracks, "track")}
              </div>
              <div className="sl-path">{a.folder || "(music folder root)"}</div>
            </article>
          ))}
        {tab === "tags" &&
          report.missingTags.slice(0, shown).map((t) => (
            <article key={t.id} className="card sl-item">
              <h3>{t.title}</h3>
              <div className="muted small">
                {[t.artist, t.album].filter(Boolean).join(" ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ") || "No artist or album"}
              </div>
              <div>
                {t.missing.map((m) => (
                  <span key={m} className="sl-tag">
                    no {FIELD_LABELS[m]}
                  </span>
                ))}
              </div>
              <div className="sl-path">{t.relPath}</div>
            </article>
          ))}
        {tab === "problems" &&
          report.problems.slice(0, shown).map((p) => (
            <article key={p.id} className="card sl-item">
              <h3>
                {p.title} <span className="sl-tag">{p.kind}</span>
              </h3>
              <div className="muted small">{p.problem}</div>
              <div className="sl-path">{p.relPath}</div>
            </article>
          ))}
      </div>
      {current.length > shown && (
        <div className="sl-more">
          <button className="btn" onClick={() => setShown(shown + PAGE)}>
            Show more
          </button>
        </div>
      )}
      {total[tab] > current.length && (
        <p className="muted small sl-more">
          Showing the first {current.length.toLocaleString()} of {total[tab].toLocaleString()}.
        </p>
      )}
      <p className="muted small" style={{ marginTop: 18 }}>
        Read-only: this page never changes or deletes files. Fix problems in your music folder, then press Scan.
      </p>
    </>
  );
}

function Body() {
  const status = useLoad(
    () => call<HealthStatus>("api/library-health/status"),
    [],
    (s) => (s?.indexing.running || s?.deepScan.running ? 2000 : null),
  );
  const report = useLoad(() => call<HealthReport>("api/library-health/report?limit=300"), []);
  const [actionError, setActionError] = useState<string | null>(null);
  const st = status.data;
  const running = !!st && (st.indexing.running || st.deepScan.running);

  // Refresh the report whenever a scan finishes.
  const wasRunning = useRef(false);
  const reloadReport = report.reload;
  useEffect(() => {
    if (wasRunning.current && !running) reloadReport();
    wasRunning.current = running;
  }, [running, reloadReport]);

  const start = async (deep: boolean) => {
    setActionError(null);
    try {
      await send("POST", `api/library-health/scan${deep ? "?deep=1" : ""}`);
      status.reload();
    } catch (err) {
      setActionError(explainError(err));
    }
  };
  const stop = async () => {
    await send("POST", "api/library-health/stop").catch(() => undefined);
    status.reload();
  };

  const active = st?.deepScan.running ? st.deepScan : st?.indexing.running ? st.indexing : null;

  return (
    <>
      <div className="sl-toolbar">
        <button className="btn primary" disabled={running} onClick={() => void start(false)}>
          Scan files
        </button>
        <button
          className="btn"
          disabled={running || st?.ffmpeg.available === false}
          onClick={() => void start(true)}
          title="Decodes every file with ffmpeg. Slow, but finds damaged audio."
        >
          Deep scan
        </button>
        {running && (
          <button className="btn ghost" onClick={() => void stop()}>
            Stop
          </button>
        )}
        {st && st.ffmpeg.available === false && <span className="muted small">Deep scan needs ffmpeg on the server.</span>}
      </div>
      {active && (
        <div className="stack" style={{ marginBottom: 16 }}>
          <Progress value={active.done + active.failed} max={active.total} label="Scan progress" />
          <span className="muted small">
            {st?.deepScan.running ? "Decoding" : "Reading"} {(active.done + active.failed).toLocaleString()} of{" "}
            {active.total.toLocaleString()}
            {active.current ? ` ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${active.current}` : ""}
          </span>
        </div>
      )}
      {st && !running && st.indexing.pending > 0 && (
        <p className="notice">{pluralize(st.indexing.pending, "file")} not scanned yet. Press Scan files.</p>
      )}
      {actionError && <p className="notice error">{actionError}</p>}
      <ErrorNotice error={status.error ?? report.error} />
      {report.loading && !report.data && <p className="empty">Loading the reportÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦</p>}
      {report.data && <Report report={report.data} />}
    </>
  );
}

export function LibraryHealthPage() {
  return (
    <Page
      title="Library health"
      subtitle="Duplicates, missing artwork and tags, and files that will not play. Nothing in your music folder is changed."
    >
      <Gate admin>
        <Body />
      </Gate>
    </Page>
  );
}
