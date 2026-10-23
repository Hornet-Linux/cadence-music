import type { Plugin } from "../../types";
import { ArchiveIcon } from "../_sourcekit/icons";
import { ArchivePage } from "./ArchivePage";
import { parseArchiveTrackId, streamAddress } from "./archiveStore";
import { useServer } from "../../builtins/server/serverStore";

/** Free recordings from the Internet Archive, including the Live Music Archive, with licences shown. */
const archivePlugin: Plugin = {
  manifest: {
    id: "cadence.internet-archive",
    name: "Internet Archive",
    version: "1.0.0",
    description:
      "Search archive.org and play its free audio, including the Live Music Archive of concert recordings. Streams go through your server, and each recording shows its creator, licence and a link back to the Archive.",
    author: "Cadence",
    capabilities: ["source.audio", "ui.sidebar", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: "internet-archive", label: "Archive", icon: <ArchiveIcon />, render: () => <ArchivePage /> });
    ctx.registerAudioSource({
      id: "internet-archive",
      label: "Internet Archive",
      async resolve(track) {
        const parsed = parseArchiveTrackId(track.id);
        if (!parsed || !useServer.getState().token) return null;
        return streamAddress(parsed.identifier, parsed.file);
      },
    });
  },
};

export default archivePlugin;