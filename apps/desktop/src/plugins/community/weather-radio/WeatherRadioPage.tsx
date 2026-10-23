import { useEffect, useState } from "react";
import { currentOption, useProviders } from "@/features/dj/providers";
import { primaryArtist } from "@/shared/types";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { useLibraryTracks } from "../_social/libraryTracks";
import { Notice, Page } from "../_social/ui";
import { FORECAST_HOST, MOODS, type MoodId } from "./mood";
import { playStation, refreshProviders, useRadio } from "./store";
import "./style.css";

export const WEATHER_ITEM_ID = "weather-radio";

function Privacy() {
  return (
    <p className="muted small wr-privacy">
      Privacy: your location stays on this device. If you choose weather, only your latitude and longitude, rounded to about a kilometre, are sent to Open-Meteo ({FORECAST_HOST}) to get the forecast. Nothing about your location goes to your Cadence server or anywhere else.
    </p>
  );
}

function Setup() {
  const { setMode, setLocation, error } = useRadio();
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [agree, setAgree] = useState(false);
  const [locating, setLocating] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const useDevice = () => {
    setLocalError(null);
    if (!navigator.geolocation) return setLocalError("This device can't share its location. Enter coordinates instead.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setLocation(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        setLocating(false);
        setLocalError(`Couldn't get your location (${err.message || "permission denied"}). Enter coordinates instead.`);
      },
      { maximumAge: 600_000, timeout: 10_000 },
    );
  };

  return (
    <div className="sx-stack">
      <section className="sx-card">
        <h2>Time of day only</h2>
        <p className="muted small">Picks music to suit the hour. Nothing is sent anywhere and no location is needed.</p>
        <button className="btn" onClick={() => setMode("time")}>
          Use time of day
        </button>
      </section>
      <section className="sx-card">
        <h2>Use the weather too</h2>
        <Privacy />
        <label className="wr-check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I agree to send my rounded coordinates to Open-Meteo to get the weather.</span>
        </label>
        <div className="sx-row" style={{ marginTop: 10 }}>
          <button className="btn" disabled={!agree || locating} onClick={useDevice}>
            {locating ? "Finding you..." : "Use my location"}
          </button>
        </div>
        <p className="muted small" style={{ margin: "12px 0 6px" }}>
          Or type coordinates (any map site shows them for a place):
        </p>
        <div className="wr-coords">
          <label>
            <span className="field-label">Latitude</span>
            <input className="text-input" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="52.52" />
          </label>
          <label>
            <span className="field-label">Longitude</span>
            <input className="text-input" inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="13.40" />
          </label>
          <button className="btn" disabled={!agree || !lat.trim() || !lon.trim()} onClick={() => setLocation(Number(lat), Number(lon))}>
            Save
          </button>
        </div>
        {(localError || error) && <Notice kind="error">{localError ?? error}</Notice>}
      </section>
    </div>
  );
}

function Keywords() {
  const { keywords, setKeywords } = useRadio();
  return (
    <details className="sx-card wr-keywords">
      <summary>Your own words for each mood</summary>
      <p className="muted small">
        Songs whose title, album or artist contains one of these words count as a better fit. Separate words with commas.
      </p>
      {(Object.keys(MOODS) as MoodId[]).map((id) => (
        <label key={id} className="wr-kw">
          <span className="field-label">{MOODS[id].label}</span>
          <input className="text-input" value={keywords[id] ?? ""} onChange={(e) => setKeywords(id, e.target.value)} placeholder="e.g. cafe, acoustic" />
        </label>
      ))}
    </details>
  );
}

export function WeatherRadioPage() {
  const radio = useRadio();
  const library = useLibraryTracks({ includeHistory: false });
  const providers = useProviders();
  const signedIn = useServer((s) => !!s.user);
  const option = providers ? currentOption() : undefined;

  useEffect(() => {
    radio.load();
    refreshProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (radio.mode === "weather") void radio.refreshWeather();
    if (radio.mode !== "off") void radio.loadTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radio.mode, signedIn]);

  const mood = radio.currentMood();
  const weatherLine = radio.weather
    ? `${radio.weather.label}${radio.weather.tempC !== null ? `, ${Math.round(radio.weather.tempC)}\u00b0C` : ""}`
    : radio.mode === "weather"
      ? radio.status === "loading"
        ? "Checking the weather..."
        : "Weather unavailable"
      : null;
  const tagged = Object.keys(radio.tags).length;

  return (
    <Page title="Weather radio" subtitle="A queue from your own library that suits the weather and the time of day.">
      {radio.mode === "off" ? (
        <Setup />
      ) : (
        <div className="sx-stack">
          <section className="sx-card wr-mood">
            <div className="eyebrow">Right now</div>
            <h2 className="wr-mood-name">{mood?.label}</h2>
            <p className="muted">{mood?.blurb}</p>
            <p className="muted small">
              {weatherLine ? `${weatherLine} · ` : ""}
              {new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              {radio.mode === "time" ? " · using the time of day only" : ""}
            </p>
            {radio.error && <Notice kind="warn">{radio.error}</Notice>}
            <div className="sx-row">
              <button className="btn primary" disabled={library.length === 0 || radio.building} onClick={() => void radio.makeStation(library)}>
                {radio.building ? "Choosing songs..." : radio.station ? "New station" : "Make a station"}
              </button>
              {radio.mode === "weather" && (
                <button className="btn" onClick={() => void radio.refreshWeather(true)} disabled={radio.status === "loading"}>
                  Refresh weather
                </button>
              )}
            </div>
            {library.length === 0 && <p className="muted small">Your library is empty. Connect your server or add local files first.</p>}
          </section>

          {radio.station && radio.stationMood && (
            <section className="sx-card">
              <h2>{radio.stationMood.label} station</h2>
              <p className="muted small">
                {radio.station.matched} of {radio.station.queue.length} songs chosen for the mood
                {radio.station.filler > 0 ? `, ${radio.station.filler} added to fill the queue` : ""}.
              </p>
              {radio.note && <Notice>{radio.note}</Notice>}
              <ol className="sx-list wr-queue">
                {radio.station.queue.map((t, i) => (
                  <li key={t.id}>
                    <span className="sx-rank">{i + 1}</span>
                    <span className="sx-grow">
                      <span className="sx-title" style={{ display: "block" }}>{t.title}</span>
                      <span className="sx-sub" style={{ display: "block" }}>{primaryArtist(t)}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <div className="sx-row" style={{ marginTop: 12 }}>
                <button className="btn primary" onClick={() => void playStation(radio.station!.queue)}>
                  Play station
                </button>
              </div>
            </section>
          )}

          <section className="sx-card">
            <h2>How songs are chosen</h2>
            {radio.tagsAvailable ? (
              <p className="muted small">
                {tagged} songs have genre tags{radio.tagsPending ? ` (${radio.tagsPending} more being read from your files)` : ""}. Genres, tempo and the words in names are matched to the mood.
              </p>
            ) : (
              <p className="muted small">
                {signedIn
                  ? "Genre tags aren't available from your server, so songs are matched by the words in their titles, albums and artists. Ask the server admin to turn on the Weather radio server plugin for genre matching."
                  : "Without a server, songs are matched by the words in their titles, albums and artists."}
              </p>
            )}
            <label className={`wr-check${option ? "" : " off"}`}>
              <input type="checkbox" checked={radio.useAi && !!option} disabled={!option} onChange={(e) => radio.setUseAi(e.target.checked)} />
              <span>Let the AI DJ suggest songs{option ? ` (${option.name})` : " (not set up)"}</span>
            </label>
            <p className="muted small">
              {option
                ? `Sends the mood and the names of your most-played artists to ${option.name}. Only suggestions that match songs in your library are used.`
                : "Set up an AI provider in Settings to use this. It is optional."}
            </p>
          </section>

          <Keywords />

          <section className="sx-card">
            <h2>Location and privacy</h2>
            <Privacy />
            <div className="sx-row">
              {radio.mode === "weather" && radio.lat !== undefined && (
                <span className="muted small">
                  Saved on this device: {radio.lat}, {radio.lon}
                </span>
              )}
              {radio.mode === "weather" && (
                <button className="btn" onClick={() => radio.setMode("time")}>
                  Stop using weather
                </button>
              )}
              {radio.mode === "time" && (
                <button className="btn" onClick={() => radio.forgetLocation()}>
                  Set up weather
                </button>
              )}
              <button className="btn ghost" onClick={() => radio.forgetLocation()}>
                Forget my location
              </button>
            </div>
          </section>
        </div>
      )}
    </Page>
  );
}