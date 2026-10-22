import { useMemo, useState } from "react";
import { CoverArt } from "@/ui/CoverArt";
import type { MetadataClient } from "../_metadata/client";
import { useLoad } from "../_metadata/useLoad";
import { loadAbout, type AboutData } from "./about";
import { useCurrentTrack } from "./nowPlaying";
import "./style.css";

function uniqueArtists(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = n.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function Bio({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320;
  return (
    <div className="about-bio selectable">
      <p className={long && !open ? "clamped" : undefined}>{text}</p>
      {long && (
        <button className="btn ghost about-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}

function AboutBody({ about, compact }: { about: AboutData; compact: boolean }) {
  return (
    <div className={"about" + (compact ? " compact" : "")}>
      <div className="about-head">
        <div className="about-photo">
          <CoverArt src={about.image} seed={about.name} label={about.name} />
        </div>
        <div className="about-title">
          <h3>{about.name}</h3>
          {about.description && <div className="muted small">{about.description}</div>}
          {about.facts.length > 0 && <div className="muted small">{about.facts.join(" · ")}</div>}
          {about.genres.length > 0 && (
            <div className="about-genres" aria-label="Genres">
              {about.genres.map((g) => (
                <span className="badge" key={g}>
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {about.extract && <Bio text={about.extract} />}
      {about.links.length > 0 && (
        <div className="about-links">
          {about.links.map((l) => (
            <a className="btn ghost" key={l.url} href={l.url} target="_blank" rel="noreferrer">
              {l.label}
            </a>
          ))}
        </div>
      )}
      {about.sources.length > 0 && <div className="muted small">From {about.sources.join(", ")}</div>}
    </div>
  );
}

/** "About this artist" for whatever is playing: biography, photo, genres and links. */
export function ArtistAbout({ client, compact = false }: { client: MetadataClient; compact?: boolean }) {
  const track = useCurrentTrack();
  const artists = useMemo(() => uniqueArtists(track?.artists.map((a) => a.name) ?? []), [track]);
  const [picked, setPicked] = useState<string | null>(null);
  const name = picked && artists.includes(picked) ? picked : artists[0];
  const loaded = useLoad((signal) => (name ? loadAbout(client, name, signal) : Promise.reject(new Error("none"))), name ?? "");

  if (!track || !name) {
    return <p className="muted small">Play a song to read about the artist.</p>;
  }
  return (
    <div className="stack">
      {artists.length > 1 && (
        <div className="segmented about-picker" role="tablist" aria-label="Artists on this track">
          {artists.map((a) => (
            <button key={a} role="tab" aria-selected={a === name} className={a === name ? "on" : ""} onClick={() => setPicked(a)}>
              {a}
            </button>
          ))}
        </div>
      )}
      {loaded.state === "loading" && <p className="muted small">Looking up {name}…</p>}
      {loaded.state === "error" && (
        <p className={"notice" + (loaded.error.kind === "not_found" ? "" : " warn")}>
          {loaded.error.kind === "not_found"
            ? "No details found for " + name + "."
            : loaded.error.kind === "no_server"
              ? "Sign in to your Cadence server to see artist details."
              : loaded.error.message}
        </p>
      )}
      {loaded.state === "ready" && <AboutBody about={loaded.data} compact={compact} />}
    </div>
  );
}

/** The full page version, with a header. */
export function ArtistAboutPage({ client }: { client: MetadataClient }) {
  return (
    <div className="view">
      <header className="view-header">
        <h1>About the artist</h1>
        <p className="muted">Details for the song that is playing, from MusicBrainz and Wikipedia.</p>
      </header>
      <div className="card pad">
        <ArtistAbout client={client} />
      </div>
    </div>
  );
}
