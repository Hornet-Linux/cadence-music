import { useEffect, useMemo } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "../../builtins/server/serverStore";
import { LoadingRows, Problem } from "../_sourcekit/ui";
import { ConnectCard, SourceBrowser } from "../sourcesCommon/SourceBrowser";
import type { BrowseApi } from "../sourcesCommon/types";
import { useIsFavourite, usePlex } from "./plexStore";

export function PlexPage() {
  const status = usePlex((s) => s.status);
  const checking = usePlex((s) => s.checking);
  const error = usePlex((s) => s.error);
  const serverUser = useServer((s) => s.user);
  const openSettings = useSettingsModal((s) => s.show);

  // Opening the page re-checks, so a link finished in another tab or a library change shows up.
  useEffect(() => {
    if (useServer.getState().token) void usePlex.getState().refresh();
  }, []);

  const api = useMemo<BrowseApi>(
    () => ({
      label: "Plex",
      listTracks: (q) => usePlex.getState().listTracks(q),
      listAlbums: (q) => usePlex.getState().listAlbums(q),
      listArtists: (q) => usePlex.getState().listArtists(q),
      albumTracks: (id) => usePlex.getState().albumTracks(id),
      listPlaylists: () => usePlex.getState().listPlaylists(),
      playlistTracks: (id) => usePlex.getState().playlistTracks(id),
      useIsFavourite,
      toggleFavourite: (t) => usePlex.getState().toggleFavourite(t),
    }),
    [],
  );

  const connected = !!status?.connected;
  const ready = connected && !!status.library;
  const settings = { label: "Open Plex settings", onClick: () => openSettings("plex") };

  return (
    <div className="view">
      <header className="view-header">
        <h1>Plex</h1>
        <p className="muted">
          {ready
            ? `${status.userName ?? "You"}${status.serverName ? ` on ${status.serverName}` : ""} · ${status.library!.title}`
            : "Your Plex music, played through your Cadence server."}
        </p>
      </header>

      {!serverUser ? (
        <ConnectCard title="Sign in to your server first" text="Plex connects through your Cadence server." action={{ label: "Open server settings", onClick: () => openSettings("server") }} />
      ) : !status ? (
        checking ? (
          <LoadingRows label="Checking Plex…" rows={3} />
        ) : (
          <Problem message={error ?? "Couldn't reach Plex."} onRetry={() => void usePlex.getState().refresh()} />
        )
      ) : !status.configured ? (
        <ConnectCard
          title="Plex isn't set up on this server"
          text={serverUser.isAdmin ? "Add your Plex server's address in the settings." : "Ask the server owner to add its address."}
          action={serverUser.isAdmin ? settings : undefined}
        />
      ) : !connected ? (
        <ConnectCard title="Link your Plex account" text={error ?? "Enter a short code at plex.tv/link to browse and play your music here."} action={settings} />
      ) : !ready ? (
        <ConnectCard title="Choose a music library" text="Pick which Plex music library to use." action={settings} />
      ) : (
        <SourceBrowser api={api} />
      )}
    </div>
  );
}