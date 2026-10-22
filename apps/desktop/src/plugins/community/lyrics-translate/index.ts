import type { Plugin } from "../../types";
import { PersistentCache, registerLyricsTranslator } from "../lyrics-view/api";
import { checkProvider, chooseProvider, senderFor } from "./providers";
import { translateCached, translationKey } from "./translate";

let unregister: (() => void) | null = null;

/** Adds a Translate switch to the lyrics page, using the AI provider chosen for the AI DJ. */
const plugin: Plugin = {
  manifest: {
    id: "cadence.lyrics-translate",
    name: "Lyrics translation",
    version: "1.0.0",
    description:
      "Translates the lyrics on the Lyrics page with your AI provider (the one picked in Settings, AI DJ). The lyric lines are sent to that provider. Translations are remembered per song and language.",
    author: "Cadence",
    capabilities: ["storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    unregister?.();
    const cache = new PersistentCache<string[]>(ctx.storage, "translations", {
      maxEntries: 60,
      maxBytes: 600_000,
      ttlMs: 180 * 24 * 60 * 60 * 1000,
    });
    unregister = registerLyricsTranslator({
      id: "cadence.lyrics-translate",
      label: "AI translation",
      async translate({ track, lines, target, signal }) {
        const cached = cache.get(translationKey(track, target, lines));
        if (cached && cached.length === lines.length) return cached;
        const option = await chooseProvider();
        await checkProvider(option);
        return translateCached(cache, track, target, lines, senderFor(option, target), signal);
      },
    });
  },
  deactivate() {
    unregister?.();
    unregister = null;
  },
};

export default plugin;
