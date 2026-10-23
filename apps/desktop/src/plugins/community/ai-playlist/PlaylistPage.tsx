import { useState } from "react";
import { AiError, AiGate } from "@/features/dj/AiUi";
import { useCollection } from "@/features/collection/collectionStore";
import { connectedLookups, noSourceMessage } from "@/features/dj/multiSource";
import { useNav } from "@/app/navStore";
import { usePlayer } from "@/player/playerStore";
import { primaryArtist } from "@/shared/types";
import { PlayIcon, PlusIcon } from "@/ui/icons";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { useJellyfin } from "@/plugins/builtins/jellyfin/jellyfinStore";
import { useSpotify } from "@/plugins/builtins/spotify/spotifyStore";
import { MAX_PROMPT } from "./playlist";
import { usePlaylistBuilder } from "./store";
import "@/features/dj/ai.css";
import "./style.css";

const EXAMPLES = ["Rainy Sunday cooking", "Focus: coding at night", "Road trip singalong", "Sunset dinner with friends", "90s workout"];
const SIZES = [10, 15, 25];

export function PlaylistPage() {
  const b = usePlaylistBuilder();
  // Re-render when a source connects or disconnects.
  useServer((s) => s.tracks.length);
  useJellyfin((s) => s.status?.connected);
  useSpotify((s) => s.status);
  const sources = connectedLookups();
  const working = b.status === "working";
  const playQueue = usePlayer((s) => s.playQueue);
  const addToQueue = usePlayer((s) => s.addToQueue);
  const createPlaylist = useCollection((s) => s.createPlaylist);
  const navigate = useNav((s) => s.navigate);
  const [name, setName] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const result = b.result;

  async function save() {
    if (!result) return;
    const id = await createPlaylist(name.trim() || result.title, result.found.map((f) => f.track));
    setSavedId(id);
  }

  return (
    <div className="view ai-playlist">
      <header className="view-header">
        <h1>AI playlist</h1>
        <p className="muted">Describe a mood, a moment or an activity. The AI suggests songs, and only songs found in your own music are kept.</p>
      </header>

      <AiGate>
        {sources.length === 0 && <div className="notice warn">{noSourceMessage()}</div>}
        <form
          className="stack ai-form"
          onSubmit={(e) => {
            e.preventDefault();
            setSavedId(null);
            setAdded(false);
            setName("");
            void b.build();
          }}
        >
          <label className="field-label" htmlFor="pl-prompt">
            What is it for?
          </label>
          <input
            id="pl-prompt"
            className="text-input"
            value={b.prompt}
            maxLength={MAX_PROMPT}
            placeholder="e.g. rainy Sunday cooking"
            onChange={(e) => b.setPrompt(e.target.value)}
          />
          <div className="ai-chips" aria-label="Ideas">
            {EXAMPLES.map((x) => (
              <button type="button" key={x} className="ai-chip" onClick={() => b.setPrompt(x)}>
                {x}
              </button>
            ))}
          </div>
          <div className="ai-options">
            <div className="ai-field">
              <span className="field-label">Songs</span>
              <div className="segmented" role="radiogroup" aria-label="Number of songs">
                {SIZES.map((n) => (
                  <button
                    type="button"
                    key={n}
                    role="radio"
                    aria-checked={b.count === n}
                    className={b.count === n ? "on" : ""}
                    onClick={() => b.setCount(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <label className="ai-check">
              <input type="checkbox" checked={b.useHistory} onChange={(e) => b.setUseHistory(e.target.checked)} /> Use my listening history as a hint
            </label>
          </div>
          <div className="ai-actions">
            <button className="btn primary big" type="submit" disabled={working || !b.prompt.trim() || sources.length === 0}>
              {working ? "Working…" : "Build playlist"}
            </button>
          </div>
        </form>

        <p className="ai-note" aria-live="polite">
          {working ? b.step : "Searching: " + (sources.length ? sources.map((s) => s.label).join(", ") : "nothing connected")}
        </p>
        <AiError error={b.error} />

        {result && (
          <section className="ai-result" aria-label="Your playlist">
            <input
              className="text-input ai-result-title"
              aria-label="Playlist name"
              value={name || result.title}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
            {result.description && <p className="muted">{result.description}</p>}
            <div className="ai-actions">
              <button
                className="btn primary"
                onClick={() =>
                  void playQueue(
                    result.found.map((f) => f.track),
                    0,
                  )
                }
              >
                <PlayIcon size={16} /> Play all
              </button>
              <button
                className="btn"
                disabled={added}
                onClick={() => {
                  result.found.forEach((f) => addToQueue(f.track));
                  setAdded(true);
                }}
              >
                <PlusIcon size={16} /> {added ? "Added to queue" : "Add to queue"}
              </button>
              {savedId ? (
                <button className="btn" onClick={() => navigate({ kind: "playlist", playlistId: savedId })}>
                  Saved. Open it
                </button>
              ) : (
                <button className="btn" onClick={() => void save()}>
                  Save as playlist
                </button>
              )}
            </div>
            <ol className="ai-songs">
              {result.found.map((f, i) => (
                <li key={f.track.id} className="ai-song">
                  <button
                    className="ai-song-play"
                    aria-label={`Play ${f.track.title}`}
                    onClick={() =>
                      void playQueue(
                        result.found.map((x) => x.track),
                        i,
                      )
                    }
                  >
                    <PlayIcon size={16} />
                  </button>
                  <div className="ai-song-text">
                    <div className="strong">{f.track.title}</div>
                    <div className="muted small">
                      {primaryArtist(f.track)}
                      {f.via ? ` · ${f.via}` : ""}
                    </div>
                    {f.why && <div className="ai-why">{f.why}</div>}
                  </div>
                </li>
              ))}
            </ol>
            {result.missing.length > 0 && (
              <details className="ai-missing">
                <summary>
                  {result.missing.length} suggested {result.missing.length === 1 ? "song was" : "songs were"} not found in your music, so they are left out
                </summary>
                <ul>
                  {result.missing.map((m) => (
                    <li key={`${m.artist}|${m.title}`} className="muted small">
                      {m.artist} – {m.title}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
      </AiGate>
    </div>
  );
}
