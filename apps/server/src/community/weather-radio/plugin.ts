import type { ServerPlugin } from "../../plugins/types.js";
import { TagIndexer } from "./tags.js";

/**
 * Reads genre and tempo tags from the music files (in the background) so the Weather radio plugin can
 * choose songs by genre. The tags describe the shared library, so every signed-in person sees the same list.
 */
const plugin: ServerPlugin = {
  id: "cadence.weather-radio",
  name: "Weather radio tags",
  version: "1.0.0",
  description:
    "Reads genre and tempo tags from the music files in the background (a few hundred files every couple of minutes) so the Weather radio feature in the player can choose songs by mood. Read-only; it never changes your files.",
  configFields: [],
  configNote: "Nothing to set here. It works as soon as it is turned on and the server restarts.",
  register(app, ctx) {
    const indexer = new TagIndexer(ctx.db, ctx.config.musicDir);
    // Gradual: up to 300 files every 2 minutes (and soon after start-up), so a big library fills in over time.
    ctx.jobs.every("weather-radio-tags", 2 * 60_000, async () => void (await indexer.run(300)), { runSoon: true });

    app.get("/api/weather-radio/tags", { preHandler: ctx.requireUser }, async () => ({
      items: indexer.list(),
      pending: indexer.countPending(),
    }));
  },
};

export default plugin;