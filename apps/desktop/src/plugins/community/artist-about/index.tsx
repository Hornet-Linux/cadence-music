import type { Plugin } from "../../types";
import { InfoIcon } from "@/ui/icons";
import { clientFor } from "../_metadata/server";
import { ArtistAbout, ArtistAboutPage } from "./ArtistAbout";
import { setCurrentTrack } from "./nowPlaying";

/** "About this artist" for the song that is playing: a sidebar page and a Home card. */
const artistAbout: Plugin = {
  manifest: {
    id: "cadence.artist-about",
    name: "About the artist",
    version: "1.0.0",
    description:
      "Shows a photo, biography, genres and links for the artist of the current song, from Wikipedia and MusicBrainz through your Cadence server (Fanart.tv photos if the admin added a key).",
    author: "Cadence",
    capabilities: ["player.read", "ui.sidebar", "ui.home.widget", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const client = clientFor(ctx);
    try {
      setCurrentTrack(ctx.player.getState().current);
    } catch {
      // The player is not ready yet; the first now-playing event fills this in.
    }
    ctx.onNowPlaying((track) => setCurrentTrack(track));
    ctx.registerSidebarItem({
      id: "artist-about",
      label: "About artist",
      icon: <InfoIcon />,
      render: () => <ArtistAboutPage client={client} />,
    });
    ctx.registerHomeWidget({
      id: "artist-about",
      title: "About this artist",
      weight: 40,
      render: () => <ArtistAbout client={client} compact />,
    });
  },
};

export default artistAbout;
