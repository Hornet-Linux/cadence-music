import { useNav } from "@/app/navStore";
import type { Plugin } from "../../types";
import { TrackRow } from "@/ui/media";
import { ServerSettings } from "./ServerSettings";
import { SERVER_TRACK_PREFIX, useServer } from "./serverStore";

function ServerLibraryPage() {
  const { url, user, tracks, total, loading, status } = useServer();
  const navigate = useNav((s) => s.navigate);

  return (
    <div className="view">
      <header className="view-header">
        <h1>Server</h1>
        <p className="muted">
          {user
            ? `${total} tracks on ${new URL(url).host}`
            : "Your self-hosted music server. Connect and sign in from Settings."}
        </p>
      </header>

      {!user ? (
        <div className="card pad stack">
          <p className="muted">
            {status === "offline"
              ? "The server isn't reachable right now."
              : "You're not signed in to a server yet."}
          </p>
          <div>
            <button className="btn primary" onClick={() => navigate({ kind: "settings" })}>
              Open server settings
            </button>
          </div>
        </div>
      ) : loading && tracks.length === 0 ? (
        <p className="empty">Loading your library…</p>
      ) : tracks.length === 0 ? (
        <p className="empty">
          No tracks yet. Put music in the server's music folder, then rescan from Settings.
        </p>
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

/** Connects the app to a self-hosted Unnamed Music server. */
export const serverPlugin: Plugin = {
  manifest: {
    id: "core.server",
    name: "Self-hosted Server",
    version: "1.0.0",
    description:
      "Connect to your own Unnamed Music server: sign in (password or OIDC such as Authentik) and stream your library.",
    author: "Unnamed Music App",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
    builtin: true,
  },
  activate(ctx) {
    void useServer.getState().init();

    ctx.registerSettingsPanel({ id: "server", title: "Server", render: () => <ServerSettings /> });
    ctx.registerSidebarItem({ id: "server", label: "Server", render: () => <ServerLibraryPage /> });
    ctx.registerLibrarySource({
      id: "server",
      label: "Your server",
      useTracks: () => useServer((s) => s.tracks),
    });
    ctx.registerAudioSource({
      id: "server",
      label: "Self-hosted server",
      resolve: async (track) =>
        track.id.startsWith(SERVER_TRACK_PREFIX)
          ? useServer.getState().streamUrl(track.id.slice(SERVER_TRACK_PREFIX.length))
          : null,
    });
  },
};
