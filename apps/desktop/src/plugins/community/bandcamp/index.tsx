import { useEffect, useState } from "react";
import type { Plugin } from "../../types";
import { BandcampWidget } from "./BandcampWidget";
import { sanitizeItems, type BandcampItem } from "./parse";

const KEY = "items";

/**
 * Bandcamp links and the official embedded player. There is no API for streaming a person's collection and
 * Cadence does not scrape or bypass anything; see parse.ts and docs/BANDCAMP.md. Bought-and-downloaded music
 * belongs in the local library instead.
 */
const bandcampPlugin: Plugin = {
  manifest: {
    id: "cadence.bandcamp",
    name: "Bandcamp links",
    version: "1.0.0",
    description:
      "Keep Bandcamp albums on your Home screen: open them on Bandcamp, or play them with Bandcamp's own embedded player when you paste its embed code. Bandcamp has no API for playing your collection, so nothing is scraped or bypassed. Bought music you downloaded plays from your library as usual.",
    author: "Cadence",
    capabilities: ["ui.home.widget", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const read = () => sanitizeItems(ctx.storage.get<unknown>(KEY));
    const listeners = new Set<(items: BandcampItem[]) => void>();
    const write = (items: BandcampItem[]) => {
      ctx.storage.set(KEY, items);
      for (const l of listeners) l(items);
    };

    function Widget() {
      const [items, setItems] = useState<BandcampItem[]>(read);
      useEffect(() => {
        listeners.add(setItems);
        return () => {
          listeners.delete(setItems);
        };
      }, []);
      return <BandcampWidget items={items} onChange={write} />;
    }

    ctx.registerHomeWidget({
      id: "bandcamp",
      title: "Bandcamp",
      weight: 10,
      render: () => <Widget />,
    });
  },
};

export default bandcampPlugin;
