import type { Lyrics, Plugin } from "../../types";
import { PersistentCache } from "../lyrics-view/cache";
import { createLrclibProvider } from "./lrclib";

const DAY = 24 * 60 * 60 * 1000;

/** Synced and plain lyrics from LRCLIB, a free community lyrics database (lrclib.net). */
const plugin: Plugin = {
  manifest: {
    id: "cadence.lyrics-lrclib",
    name: "Lyrics from LRCLIB",
    version: "1.0.0",
    description:
      "Finds time-synced and plain lyrics for the playing track on LRCLIB, a free community lyrics database. Sends the artist, title, album and length of tracks you open lyrics for to lrclib.net.",
    author: "Cadence",
    capabilities: ["provider.lyrics", "network.outbound", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const cache = new PersistentCache<Lyrics>(ctx.storage, "cache", {
      maxEntries: 150,
      maxBytes: 600_000,
      ttlMs: 30 * DAY,
      // A song missing today may be added tomorrow.
      missTtlMs: DAY,
    });
    ctx.registerLyricsProvider(createLrclibProvider({ fetch: (...args) => ctx.fetch(...args), cache }));
  },
};

export default plugin;
