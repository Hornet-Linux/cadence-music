import type { Plugin } from "../../types";
import { clientFor } from "../_metadata/server";
import { NewReleases } from "./NewReleases";

/** Home card: "New from artists you like", from MusicBrainz release groups of the last 90 days. */
const newReleases: Plugin = {
  manifest: {
    id: "cadence.new-releases",
    name: "New from artists you like",
    version: "1.0.0",
    description:
      "Shows albums, EPs and singles released in the last 90 days by the artists you listen to most, found through MusicBrainz via your Cadence server. You can dismiss items you have seen.",
    author: "Cadence",
    capabilities: ["ui.home.widget", "storage", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const client = clientFor(ctx);
    ctx.registerHomeWidget({
      id: "new-releases",
      title: "New from artists you like",
      weight: 35,
      render: () => <NewReleases client={client} storage={ctx.storage} />,
    });
  },
};

export default newReleases;
