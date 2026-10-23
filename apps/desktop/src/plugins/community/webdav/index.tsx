import type { Plugin } from "../../types";
import { FolderIcon } from "@/ui/icons";
import { useServer } from "../../builtins/server/serverStore";
import { remoteId } from "../_remoteSource/logic";
import { RemoteSourcePage } from "../_remoteSource/RemoteSourcePage";
import { WebdavSettings } from "./WebdavSettings";
import { useWebdav, WEBDAV_PREFIX } from "./store";

let watchingServer = false;

/** WebDAV follows the Cadence account: look it up on sign-in, forget it on sign-out. */
function followServerAccount() {
  if (watchingServer) return;
  watchingServer = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) void useWebdav.getState().refresh();
    else useWebdav.getState().reset();
  });
}

/** Music on a WebDAV share (Nextcloud, ownCloud, most NAS boxes), indexed and streamed through your Cadence server. */
const webdavPlugin: Plugin = {
  manifest: {
    id: "cadence.webdav",
    name: "WebDAV (Nextcloud, ownCloud, NAS)",
    version: "1.0.0",
    description:
      "Play music stored on a Nextcloud, ownCloud or NAS WebDAV share. Your Cadence server indexes the folders you pick and streams the files, so this device never sees the share's password. The server owner must turn the plugin on at the server too.",
    author: "Cadence",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    followServerAccount();
    if (useServer.getState().user) void useWebdav.getState().refresh();

    ctx.registerSettingsPanel({
      id: "webdav",
      title: "WebDAV",
      description: "Music on Nextcloud, ownCloud or a NAS, played through your server.",
      icon: <FolderIcon size={19} />,
      keywords: ["nextcloud", "owncloud", "nas", "synology", "network drive", "cloud", "files"],
      render: () => <WebdavSettings />,
    });
    ctx.registerSidebarItem({
      id: "webdav",
      label: "WebDAV",
      icon: <FolderIcon />,
      render: () => (
        <RemoteSourcePage
          store={useWebdav}
          title="WebDAV"
          label="WebDAV"
          settingsId="webdav"
          intro="Music from your Nextcloud, ownCloud or NAS share, played through your Cadence server."
        />
      ),
    });
    ctx.registerLibrarySource({ id: "webdav", label: "WebDAV", useTracks: () => useWebdav((s) => s.tracks) });
    ctx.registerAudioSource({
      id: "webdav",
      label: "WebDAV",
      async resolve(track) {
        const id = remoteId(track, WEBDAV_PREFIX);
        if (!id || !useServer.getState().token) return null;
        return useWebdav.getState().streamUrl(id);
      },
    });
  },
};

export default webdavPlugin;
