import type { Plugin } from "../../types";
import { DiscIcon } from "@/ui/icons";
import { useServer } from "../../builtins/server/serverStore";
import { remoteId } from "../_remoteSource/logic";
import { RemoteSourcePage } from "../_remoteSource/RemoteSourcePage";
import { CloudSettings } from "./CloudSettings";
import { GDRIVE_PREFIX, ONEDRIVE_PREFIX, useGoogleDrive, useOneDrive } from "./cloud";

/*
 * UNTESTED AGAINST THE REAL SERVICES. The server half was built from Google's and Microsoft's public
 * documentation and exercised only against imitations of their APIs (see docs/CLOUD_SOURCES.md).
 */

let watchingServer = false;

function refreshBoth() {
  void useGoogleDrive.getState().refresh();
  void useOneDrive.getState().refresh();
}

/** Both drives follow the Cadence account: look them up on sign-in, forget them on sign-out. */
function followServerAccount() {
  if (watchingServer) return;
  watchingServer = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) refreshBoth();
    else {
      useGoogleDrive.getState().reset();
      useOneDrive.getState().reset();
    }
  });
}

/** Music in Google Drive and OneDrive, read-only through their official OAuth APIs, played through your Cadence server. */
const cloudPlugin: Plugin = {
  manifest: {
    id: "cadence.onedrive-gdrive",
    name: "Google Drive & OneDrive (experimental)",
    version: "1.0.0",
    description:
      "Play music stored in Google Drive or OneDrive. You sign in on the provider's own page and Cadence only gets read access; your Cadence server indexes the folders you pick and streams the files. The server owner registers an OAuth app first. Experimental: not yet tested against the real services.",
    author: "Cadence",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    followServerAccount();
    if (useServer.getState().user) refreshBoth();

    ctx.registerSettingsPanel({
      id: "onedrive-gdrive",
      title: "Google Drive & OneDrive",
      description: "Music in your Google Drive or OneDrive (experimental).",
      icon: <DiscIcon size={19} />,
      keywords: ["google", "drive", "onedrive", "microsoft", "cloud", "oauth"],
      render: () => <CloudSettings />,
    });
    ctx.registerSidebarItem({
      id: "gdrive",
      label: "Google Drive",
      icon: <DiscIcon />,
      render: () => (
        <RemoteSourcePage
          store={useGoogleDrive}
          title="Google Drive"
          label="Google Drive"
          settingsId="onedrive-gdrive"
          intro="Music from your Google Drive, played through your Cadence server."
        />
      ),
    });
    ctx.registerSidebarItem({
      id: "onedrive",
      label: "OneDrive",
      icon: <DiscIcon />,
      render: () => (
        <RemoteSourcePage
          store={useOneDrive}
          title="OneDrive"
          label="OneDrive"
          settingsId="onedrive-gdrive"
          intro="Music from your OneDrive, played through your Cadence server."
        />
      ),
    });
    ctx.registerLibrarySource({ id: "gdrive", label: "Google Drive", useTracks: () => useGoogleDrive((s) => s.tracks) });
    ctx.registerLibrarySource({ id: "onedrive", label: "OneDrive", useTracks: () => useOneDrive((s) => s.tracks) });
    ctx.registerAudioSource({
      id: "gdrive",
      label: "Google Drive",
      async resolve(track) {
        const id = remoteId(track, GDRIVE_PREFIX);
        if (!id || !useServer.getState().token) return null;
        return useGoogleDrive.getState().streamUrl(id);
      },
    });
    ctx.registerAudioSource({
      id: "onedrive",
      label: "OneDrive",
      async resolve(track) {
        const id = remoteId(track, ONEDRIVE_PREFIX);
        if (!id || !useServer.getState().token) return null;
        return useOneDrive.getState().streamUrl(id);
      },
    });
  },
};

export default cloudPlugin;
