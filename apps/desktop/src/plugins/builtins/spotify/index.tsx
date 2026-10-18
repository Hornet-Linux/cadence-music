import { useSettingsModal } from "@/features/settings/settingsStore";
import type { Plugin } from "../../types";
import { WavesIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";
import { createSpotifyPlayback } from "./player";
import { SpotifySettings } from "./SpotifySettings";
import { useSpotify } from "./spotifyStore";

function SpotifyPage() {
  const { status, tracks, total, loading } = useSpotify();
  const openSettings = useSettingsModal((s) => s.show);

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
            <button className="btn primary" onClick={() => openSettings("spotify")}>
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
    author: "Cadence",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
    builtin: true,
  },
  activate(ctx) {
    void useSpotify.getState().init();

    ctx.registerSettingsPanel({
      id: "spotify",
      title: "Spotify",
      description: "Your liked songs, played in the app with Premium.",
      icon: <WavesIcon size={19} />,
      keywords: ["account", "streaming", "premium", "client id"],
      render: () => <SpotifySettings />,
    });
    ctx.registerSetupStep({
      id: "spotify",
      title: "Connect Spotify",
      description: "Bring in your liked songs and play them here. Playback needs Spotify Premium.",
      weight: 50,
      render: () => <SpotifySettings />,
    });
    ctx.registerSidebarItem({ id: "spotify", label: "Spotify", icon: <WavesIcon />, render: () => <SpotifyPage /> });
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
