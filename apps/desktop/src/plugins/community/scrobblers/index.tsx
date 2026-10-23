import type { Plugin } from "../../types";
import { DiscIcon } from "@/ui/icons";
import { useServer } from "../../builtins/server/serverStore";
import { ScrobblersSettings } from "./ScrobblersSettings";
import { useScrobblers } from "./scrobblersStore";
import "./style.css";

let watchingServer = false;

/** Forget one person's connections when they sign out of the server. */
function followServerAccount() {
  if (watchingServer) return;
  watchingServer = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username !== prev.user?.username) useScrobblers.getState().reset();
  });
}

/**
 * Connect Last.fm, Libre.fm, ListenBrainz and Maloja. The scrobbling itself happens on your
 * server (so phones and every other device are covered); this is the place to set it up.
 */
const scrobblersPlugin: Plugin = {
  manifest: {
    id: "cadence.scrobblers",
    name: "Scrobblers",
    version: "1.0.0",
    description: "Send what you play to Last.fm, Libre.fm, ListenBrainz or Maloja, from every device, through your server.",
    author: "Cadence",
    capabilities: ["ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    followServerAccount();
    ctx.registerSettingsPanel({
      id: "scrobblers",
      title: "Scrobbling",
      description: "Last.fm, Libre.fm, ListenBrainz and Maloja.",
      icon: <DiscIcon size={19} />,
      keywords: ["last.fm", "lastfm", "listenbrainz", "libre.fm", "maloja", "scrobble", "history", "listens"],
      render: () => <ScrobblersSettings />,
    });
  },
};

export default scrobblersPlugin;
