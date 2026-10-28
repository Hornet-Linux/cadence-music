import { useEffect, useState, type FormEvent } from "react";
import { usePluginHost } from "@/plugins/host";
import { primaryArtist } from "@/shared/types";
import { SearchIcon } from "@/ui/icons";
import { FontControls, OffsetControls, TranslateControls, TranslateNote } from "./Controls";
import { Karaoke } from "./Karaoke";
import { LyricsBody } from "./LyricsBody";
import { isInstrumental } from "./lrc";
import { useLyricsView } from "./lyricsStore";

function SearchAgain() {
  const track = useLyricsView((s) => s.track);
  const query = useLyricsView((s) => s.query);
  const search = useLyricsView((s) => s.search);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");

  useEffect(() => {
    setTitle(query?.title ?? track?.title ?? "");
    setArtist(query?.artist ?? (track ? primaryArtist(track) : ""));
  }, [track, query]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) search({ title: title.trim(), artist: artist.trim() });
  };

  return (
    <form className="lv-search" onSubmit={submit}>
      <label className="lv-field">
        <span>Title</span>
        <input
          className="text-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="lv-field">
        <span>Artist</span>
        <input
          className="text-input"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
        />
      </label>
      <div className="lv-group">
        <button
          type="submit"
          className="lv-btn strong"
          disabled={!title.trim()}
        >
          <SearchIcon size={16} /> Search
        </button>
        {query && (
          <button type="button" className="lv-btn" onClick={() => search(null)}>
            Use the track details
          </button>
        )}
      </div>
    </form>
  );
}

function Status() {
  const phase = useLyricsView((s) => s.phase);
  const track = useLyricsView((s) => s.track);
  const errors = useLyricsView((s) => s.errors);
  const load = useLyricsView((s) => s.load);
  const choice = useLyricsView((s) => s.choice);
  const lyrics = useLyricsView((s) => s.lyrics);
  const providers = usePluginHost((s) => s.contributions.lyricsProviders);

  if (!track)
    return (
      <p className="lv-note">Play a song and its lyrics will appear here.</p>
    );
  if (phase === "no-providers" || (phase === "idle" && !providers.length)) {
    return (
      <p className="lv-note">
        No lyrics source is turned on. Open Settings, then Plugins, and enable{" "}
        <strong>Lyrics from LRCLIB</strong>.
      </p>
    );
  }
  if (phase === "loading" || phase === "idle") {
    return (
      <p className="lv-note" role="status">
        Finding lyrics{"…"}
      </p>
    );
  }
  if (phase === "none") {
    return (
      <p className="lv-note" role="status">
        No lyrics found for this track
        {choice !== "auto" ? " from this source" : ""}. Try{" "}
        <em>Search again</em> with a simpler title, or pick another source.
      </p>
    );
  }
  if (phase === "error") {
    return (
      <p className="lv-note warn" role="alert">
        Could not get lyrics. {errors.join(" ")}{" "}
        <button
          type="button"
          className="lv-link"
          onClick={() => void load({ fresh: true })}
        >
          Try again
        </button>
      </p>
    );
  }
  if (lyrics && !isInstrumental(lyrics)) {
    return (
      <p className="lv-credit">
        Lyrics from {lyrics.source}
        {" · "}
        {lyrics.synced
          ? "time-synced, tap a line to jump to it"
          : "not time-synced"}
      </p>
    );
  }
  return null;
}

/** The Lyrics page in the sidebar. */
export function LyricsPage() {
  const track = useLyricsView((s) => s.track);
  const phase = useLyricsView((s) => s.phase);
  const attach = useLyricsView((s) => s.attach);
  const choice = useLyricsView((s) => s.choice);
  const setChoice = useLyricsView((s) => s.setChoice);
  const karaoke = useLyricsView((s) => s.karaoke);
  const setKaraoke = useLyricsView((s) => s.setKaraoke);
  const providers = usePluginHost((s) => s.contributions.lyricsProviders);
  const [searching, setSearching] = useState(false);

  useEffect(() => attach(), [attach]);
  // Providers can appear after the page opens (a plugin was just enabled).
  useEffect(() => {
    if (providers.length && phase === "no-providers")
      useLyricsView.getState().load();
  }, [providers.length, phase]);

  const canKaraoke = !!track;
  return (
    <div className="view lv-page">
      <header className="view-header lv-head">
        <h1>Lyrics</h1>
        {track ? (
          <p className="lv-now">
            <strong>{track.title}</strong>
            <span className="muted">
              {" "}
              {"·"} {primaryArtist(track)}
            </span>
          </p>
        ) : null}
      </header>

      {!track && (
        <p className="lv-empty">
          Play a song and its lyrics will appear here, following along as it
          plays.
        </p>
      )}
      {track && (
        <div className="lv-toolbar">
          <div className="lv-group">
            <label className="lv-select-wrap">
              <span className="lv-sr">Lyrics source</span>
              <select
                className="lv-select"
                value={providers.some((p) => p.id === choice) ? choice : "auto"}
                onChange={(e) => setChoice(e.target.value)}
                aria-label="Lyrics source"
              >
                <option value="auto">Source: automatic</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`lv-btn${searching ? " on" : ""}`}
              aria-expanded={searching}
              onClick={() => setSearching((v) => !v)}
              disabled={!track}
            >
              Search again
            </button>
          </div>
          <FontControls />
          <OffsetControls />
          <TranslateControls />
          <button
            type="button"
            className="lv-btn strong"
            onClick={() => setKaraoke(true)}
            disabled={!canKaraoke}
          >
            Karaoke mode
          </button>
        </div>
      )}

      {searching && track && <SearchAgain />}
      {track && <Status />}
      <TranslateNote />
      {phase === "ready" && <LyricsBody variant="page" />}
      {karaoke && <Karaoke />}
    </div>
  );
}
