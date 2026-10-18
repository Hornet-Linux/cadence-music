import { useSettingsModal } from "@/features/settings/settingsStore";
import type { Plugin } from "../../types";
import { NoteIcon } from "@/ui/icons";
import { TrackRow } from "@/ui/media";
import { useServer } from "../server/serverStore";
import { APPLE_CATALOG_PREFIX, APPLE_LIBRARY_PREFIX, useAppleMusic } from "./appleMusicStore";
import { createApplePlayback } from "./musickit";

function AppleMusicSettings() {
  const a = useAppleMusic();
  const serverSignedIn = useServer((s) => !!s.user);

  if (a.status === "unavailable") {
    return (
      <div className="stack">
        <p className="muted small">
          {serverSignedIn
            ? "Your server doesn't have Apple Music set up yet."
            : "Sign in to your server first — Apple Music uses a key stored on your server."}
        </p>
        {serverSignedIn && (
          <p className="notice">
            Apple requires an Apple Developer Program membership to create the MusicKit key every
            third-party Apple Music app needs. Once you have one, add the key to your server (see
            SELF_HOSTING.md, "Apple Music") and restart it. Your Apple Music subscription then
            works here.
          </p>
        )}
      </div>
    );
  }

  if (a.status === "signed-in") {
    return (
      <div className="stack">
        <div className="signed-in">
          <div>
            <div className="strong">Apple Music</div>
            <div className="muted small">
              {a.loading ? `loading… ${a.tracks.length}` : `${a.tracks.length} songs in your library`}
            </div>
          </div>
          <div className="row">
            <button className="btn ghost" disabled={a.loading} onClick={() => void a.loadLibrary()}>
              Reload
            </button>
            <button className="btn ghost" onClick={() => void a.disconnect()}>
              Disconnect
            </button>
          </div>
        </div>
        {a.error && <p className="notice error">{a.error}</p>}
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="muted small">
        Sign in with your Apple ID to bring in your Apple Music library and play it here (an Apple
        Music subscription is required for playback).
      </p>
      <div>
        <button className="btn primary" disabled={a.status === "connecting"} onClick={() => void a.connect()}>
          {a.status === "connecting" ? "Waiting for Apple…" : "Connect Apple Music"}
        </button>
      </div>
      {a.error && <p className="notice error">{a.error}</p>}
    </div>
  );
}

function AppleMusicPage() {
  const { status, tracks, loading } = useAppleMusic();
  const openSettings = useSettingsModal((s) => s.show);
  return (
    <div className="view">
      <header className="view-header">
        <h1>Apple Music</h1>
        <p className="muted">
          {status === "signed-in" ? `${tracks.length} songs in your library` : "Your Apple Music library."}
        </p>
      </header>
      {status !== "signed-in" ? (
        <div className="card pad stack">
          <p className="muted">Apple Music isn't connected yet.</p>
          <div>
            <button className="btn primary" onClick={() => openSettings("apple-music")}>
              Open settings
            </button>
          </div>
        </div>
      ) : loading && tracks.length === 0 ? (
        <p className="empty">Loading your library…</p>
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

let watchingServer = false;

/** Official Apple Music connection through MusicKit, keyed by your server. */
export const appleMusicPlugin: Plugin = {
  manifest: {
    id: "core.apple-music",
    name: "Apple Music",
    version: "1.0.0",
    description:
      "Sign in with your Apple ID to import your Apple Music library and play it in the app. Needs a MusicKit key on your server.",
    author: "Unnamed Music App",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
    builtin: true,
  },
  activate(ctx) {
    if (!watchingServer) {
      watchingServer = true;
      // Availability follows the server connection (it holds the MusicKit key).
      useServer.subscribe((state, prev) => {
        if (state.integrations !== prev.integrations) void useAppleMusic.getState().sync();
      });
    }
    void useAppleMusic.getState().sync();

    ctx.registerSettingsPanel({
      id: "apple-music",
      title: "Apple Music",
      description: "Your Apple Music library, played in the app with a subscription.",
      icon: <NoteIcon size={19} />,
      keywords: ["account", "streaming", "musickit", "apple id"],
      render: () => <AppleMusicSettings />,
    });
    ctx.registerSetupStep({
      id: "apple-music",
      title: "Connect Apple Music",
      description: "Bring in your Apple Music library and play it here. Playback needs an Apple Music subscription.",
      weight: 40,
      render: () => <AppleMusicSettings />,
    });
    ctx.registerSidebarItem({
      id: "apple-music",
      label: "Apple Music",
      icon: <NoteIcon />,
      render: () => <AppleMusicPage />,
    });
    ctx.registerLibrarySource({
      id: "apple-music",
      label: "Apple Music",
      useTracks: () => useAppleMusic((s) => s.tracks),
    });
    ctx.registerAudioSource({
      id: "apple-music",
      label: "Apple Music",
      async resolve(track) {
        const catalog = track.id.startsWith(APPLE_CATALOG_PREFIX);
        const library = track.id.startsWith(APPLE_LIBRARY_PREFIX);
        if (!catalog && !library) return null;
        if (useAppleMusic.getState().status !== "signed-in") return null;
        try {
          const music = await useAppleMusic.getState().musicKit();
          return createApplePlayback(
            music,
            catalog
              ? { catalogId: track.id.slice(APPLE_CATALOG_PREFIX.length) }
              : { libraryId: track.id.slice(APPLE_LIBRARY_PREFIX.length) },
          );
        } catch (err) {
          useAppleMusic.getState().setError((err as Error).message);
          return null;
        }
      },
    });
  },
};
