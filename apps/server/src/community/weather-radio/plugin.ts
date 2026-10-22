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