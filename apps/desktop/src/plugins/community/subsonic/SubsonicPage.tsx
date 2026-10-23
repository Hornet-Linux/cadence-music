import { useMemo } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "../../builtins/server/serverStore";
import { ConnectCard, SourceBrowser } from "../sourcesCommon/SourceBrowser";
import type { BrowseApi } from "../sourcesCommon/types";
import { useIsFavourite, useSubsonic } from "./subsonicStore";

export function SubsonicPage() {
  const status = useSubsonic((s) => s.status);
  const checking = useSubsonic((s) => s.checking);
  const error = useSubsonic((s) => s.error);
  const serverUser = useServer((s) => s.user);
  const openSettings = useSettingsModal((s) => s.show);

  const api = useMemo<BrowseApi>(() => {
    const s = useSubsonic.getState();
    return {
      label: "Subsonic",
      listTracks: (q) => useSubsonic.getState().listTracks(q),
      listAlbums: (q) => useSubsonic.getState().listAlbums(q),
      listArtists: (q) => useSubsonic.getState().listArtists(q),
      albumTracks: (id) => useSubsonic.getState().albumTracks(id),
      listPlaylists: () => useSubsonic.getState().listPlaylists(),
      playlistTracks: (id) => useSubsonic.getState().playlistTracks(id),
      useIsFavourite,
      toggleFavourite: s.toggleFavourite,
    };
  }, []);

  const connected = !!status?.connected;
  const settings = { label: "Open Subsonic settings", onClick: () => openSettings("subsonic") };

  return (
    <div className="view">
      <header className="view-header">
        <h1>Subsonic</h1>
        <p className="muted">
          {connected
            ? `${status.userName ?? "You"}${status.serverName ? ` on ${status.serverName}` : ""}`
            : "Your Navidrome, Airsonic or Gonic library, played through your Cadence server."}
        </p>
      </header>

      {!serverUser ? (
        <ConnectCard title="Sign in to your server first" text="Subsonic connects through your Cadence server." action={{ label: "Open server settings", onClick: () => openSettings("server") }} />
      ) : !status ? (
        <p className="empty">{checking ? "Checking Subsonic…" : (error ?? "Couldn't check Subsonic.")}</p>
      ) : !status.configured ? (
        <ConnectCard
          title="Subsonic isn't set up on this server"
          text={serverUser.isAdmin ? "Add your Subsonic server's address in the settings." : "Ask the server owner to add its address."}
          action={serverUser.isAdmin ? settings : undefined}
        />
      ) : !connected ? (
        <ConnectCard title="Sign in to Subsonic" text={error ?? "Use your own account to browse and play your music here."} action={settings} />
      ) : (
        <SourceBrowser api={api} />
      )}
    </div>
  );
}