import { useNav } from "@/app/navStore";
import type { Plugin } from "../../types";
import { TrackRow } from "@/ui/media";
import { createSpotifyPlayback } from "./player";
import { SpotifySettings } from "./SpotifySettings";
import { useSpotify } from "./spotifyStore";

function SpotifyPage() {
  const { status, tracks, total, loading } = useSpotify();
  const navigate = useNav((s) => s.navigate);

  return (
    <div className="view">
      <header className="view-header">
        <h1>Spotify</h1>
        <p className="muted">
          {status === "signed-in"
            ? `${tracks.length} of ${total} liked songs`
            : "Your Spotify liked songs, playable right here with Premium."}
        </p>
      </header>
      {status !== "signed-in" ? (
        <div className="card pad stack">
          <p className="muted">Spotify isn't connected yet.</p>
          <div>
            <button className="btn primary" onClick={() => navigate({ kind: "settings" })}>
              Connect in Settings
            </button>
          </div>
        </div>
      ) : loading && tracks.length === 0 ? (
        <p className="empty">Loading your liked songs…</p>
      ) : tracks.length === 0 ? (
        <p className="empty">No liked songs on this Spotify account.</p>
      ) : (
        <div className="track-list">
          {tracks.map((t, i) => (
            <TrackRow key={t.id} track={t} index={i} queue={tracks} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Official Spotify connection: OAuth sign-in, liked songs and in-app playback. */
export const spotifyPlugin: Plugin = {
  manifest: {
    id: "core.spotify",
    name: "Spotify",
    version: "1.0.0",
    description:
      "Sign in with Spotify to import your liked songs and play them in the app (Premium required for playback).",
    author: "Unnamed Music App",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
    builtin: true,
  },
  activate(ctx) {
    void useSpotify.getState().init();

    ctx.registerSettingsPanel({ id: "spotify", title: "Spotify", render: () => <SpotifySettings /> });
    ctx.registerSidebarItem({ id: "spotify", label: "Spotify", render: () => <SpotifyPage /> });
    ctx.registerLibrarySource({
      id: "spotify",
      label: "Spotify",
      useTracks: () => useSpotify((s) => s.tracks),
    });
    ctx.registerAudioSource({
      id: "spotify",
      label: "Spotify",
      async resolve(track) {
        if (!track.id.startsWith("spotify:track:")) return null;
        if (useSpotify.getState().status !== "signed-in") return null;
        try {
          return await createSpotifyPlayback(track.id);
        } catch (err) {
          useSpotify.getState().setError((err as Error).message);
          return null;
        }
      },
    });
  },
};
