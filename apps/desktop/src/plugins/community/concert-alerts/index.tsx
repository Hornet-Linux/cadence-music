import type { Plugin } from "../../types";
import { clientFor } from "../_metadata/server";
import { ConcertAlerts } from "./ConcertAlerts";

/** Home card: upcoming concerts near your city for the artists you play most. */
const concertAlerts: Plugin = {
  manifest: {
    id: "cadence.concert-alerts",
    name: "Concert alerts",
    version: "1.0.0",
    description:
      "Shows upcoming concerts near a city you choose for the artists you listen to most, using Bandsintown through your Cadence server. The server admin adds a Bandsintown app id under Settings, Metadata services.",
    author: "Cadence",
    capabilities: ["ui.home.widget", "storage", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const client = clientFor(ctx);
    ctx.registerHomeWidget({
      id: "concert-alerts",
      title: "Concerts near you",
      weight: 30,
      render: () => <ConcertAlerts client={client} storage={ctx.storage} />,
    });
  },
};

export default concertAlerts;
