import type { Plugin } from "../../types";
import { SlidersIcon } from "@/ui/icons";
import { clientFor } from "../_metadata/server";
import { MetadataSettings } from "./MetadataSettings";
import { discogsProvider, musicBrainzProvider, wikipediaProvider } from "./providers";

/**
 * Artwork, year, genres, links and biographies for the track that is playing, from MusicBrainz,
 * the Cover Art Archive, Wikipedia and (optionally) Discogs. Every lookup goes through the
 * Cadence server, which caches answers and respects each service rate limit.
 */
const metadataProviders: Plugin = {
  manifest: {
    id: "cadence.metadata-providers",
    name: "Metadata providers",
    version: "1.0.0",
    description:
      "Adds album covers, release years, genres, links and artist biographies from MusicBrainz, Cover Art Archive, Wikipedia and Discogs, fetched through your Cadence server. Needs the Metadata plugin turned on in the server.",
    author: "Cadence",
    capabilities: ["provider.metadata", "network.outbound", "ui.settings"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const client = clientFor(ctx);
    ctx.registerMetadataProvider(musicBrainzProvider(client));
    ctx.registerMetadataProvider(wikipediaProvider(client));
    ctx.registerMetadataProvider(discogsProvider(client));
    ctx.registerSettingsPanel({
      id: "metadata-services",
      title: "Metadata services",
      description: "Artist details, covers and concerts from MusicBrainz, Wikipedia, Fanart.tv, Discogs and Bandsintown.",
      icon: <SlidersIcon size={19} />,
      keywords: ["musicbrainz", "wikipedia", "fanart", "discogs", "bandsintown", "api key", "artwork", "biography", "concerts"],
      render: () => <MetadataSettings client={client} ctx={ctx} />,
    });
  },
};

export default metadataProviders;
