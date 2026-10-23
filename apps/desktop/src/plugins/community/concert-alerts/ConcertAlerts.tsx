import { useEffect, useRef, useState } from "react";
import { useServer } from "../../builtins/server/serverStore";
import { artistsKey, useTopArtists } from "../_metadata/artists";
import type { MetadataClient } from "../_metadata/client";
import type { PluginStorage } from "../../types";
import { findConcerts, locationText, parseLocation, showDate, type ConcertResult, type Location } from "./concerts";
import "./style.css";

const TOP_ARTISTS = 12;
const LOCATION_KEY = "location";

function LocationForm({ initial, onSave, onCancel }: { initial: string; onSave: (loc: Location) => void; onCancel?: () => void }) {
  const [text, setText] = useState(initial);
  const parsed = parseLocation(text);
  return (
    <form
      className="concert-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed) onSave(parsed);
      }}
    >
      <label className="field-label" htmlFor="concert-city">
        Your city (add a country to narrow it, like Paris, France)
      </label>
      <div className="row">
        <input
          id="concert-city"
          className="text-input"
          placeholder="City"
          autoComplete="address-level2"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={!parsed}>
          Save
        </button>
        {onCancel && (
          <button className="btn ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ShowRow({ show }: { show: ConcertResult["shows"][number] }) {
  const date = showDate(show.datetime);
  const link = show.ticketUrl ?? show.url;
  return (
    <li className="concert-row">
      <div className="concert-date" aria-hidden>
        <span className="concert-month">{date ? date.toLocaleString("en", { month: "short" }) : ""}</span>
        <span className="concert-day">{date ? date.getDate() : ""}</span>
      </div>
      <div className="concert-body">
        <div className="strong concert-artist">{show.artist}</div>
        <div className="muted small concert-where">
          {show.venue}
          {show.city ? " · " + show.city : ""}
          {date ? " · " + date.toLocaleString("en", { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""}
        </div>
      </div>
      {link && (
        <a className="btn ghost concert-link" href={link} target="_blank" rel="noreferrer" aria-label={"Tickets or details for " + show.artist}>
          {show.ticketUrl ? "Tickets" : "Details"}
        </a>
      )}
    </li>
  );
}

/** Upcoming shows near a city, for the artists you listen to most. */
export function ConcertAlerts({ client, storage }: { client: MetadataClient; storage: PluginStorage }) {
  const signedIn = useServer((s) => s.user !== null);
  const [loc, setLoc] = useState<Location | null>(() => {
    const saved = storage.get<string>(LOCATION_KEY);
    return saved ? parseLocation(saved) : null;
  });
  const [editing, setEditing] = useState(false);
  const artists = useTopArtists(TOP_ARTISTS);
  const key = artistsKey(artists) + "@" + (loc ? locationText(loc) : "");
  const [result, setResult] = useState<{ key: string; value: ConcertResult } | null>(null);
  const artistsRef = useRef(artists);
  artistsRef.current = artists;

  useEffect(() => {
    if (!loc || !signedIn || artistsRef.current.length === 0) return;
    const controller = new AbortController();
    void findConcerts(client, artistsRef.current, loc, {
      signal: controller.signal,
      onProgress: (value) => {
        if (!controller.signal.aborted) setResult({ key, value });
      },
    }).catch(() => undefined);
    return () => controller.abort();
  }, [client, loc, key, signedIn]);

  if (!signedIn) return <p className="muted small">Sign in to your Cadence server to see concerts near you.</p>;

  const save = (next: Location) => {
    storage.set(LOCATION_KEY, locationText(next));
    setLoc(next);
    setEditing(false);
  };

  if (!loc || editing) {
    return (
      <div className="stack">
        {!loc && (
          <p className="muted small">
            Tell Cadence where you are and it will watch for shows by artists you play. The city stays on this device.
          </p>
        )}
        <LocationForm initial={loc ? locationText(loc) : ""} onSave={save} onCancel={loc ? () => setEditing(false) : undefined} />
      </div>
    );
  }

  const current = result && result.key === key ? result.value : null;
  const loading = artists.length > 0 && (!current || current.checked < artists.length) && !current?.notConfigured;

  return (
    <div className="stack concerts">
      <div className="concert-head">
        <span className="muted small">Near {locationText(loc)}</span>
        <button className="btn ghost concert-change" onClick={() => setEditing(true)}>
          Change city
        </button>
      </div>
      {artists.length === 0 && <p className="muted small">Play some music and shows by your favourite artists will appear here.</p>}
      {current?.notConfigured && (
        <p className="notice">
          Concert lookups need a Bandsintown app id. Ask your server admin to add it under Settings, Metadata services.
        </p>
      )}
      {current && current.shows.length > 0 && (
        <ul className="concert-list">
          {current.shows.map((s) => (
            <ShowRow key={s.id + s.artist} show={s} />
          ))}
        </ul>
      )}
      {loading && (
        <p className="muted small">
          Checking your top artists… {current ? current.checked + " of " + artists.length : ""}
        </p>
      )}
      {!loading && current && !current.notConfigured && current.shows.length === 0 && (
        <p className="muted small">
          No upcoming shows near {locationText(loc)} for your top {artists.length} artists.
          {current.failed > 0 ? " " + current.failed + " could not be checked." : ""}
        </p>
      )}
      {!loading && current && current.shows.length > 0 && current.failed > 0 && (
        <p className="muted small">{current.failed} artists could not be checked right now.</p>
      )}
    </div>
  );
}
