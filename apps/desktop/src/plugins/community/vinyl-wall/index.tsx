import type { Plugin } from "@/plugins/types";
import { ShelfIcon } from "../_social/ui";
import { VINYL_ITEM_ID, VinylWall } from "./VinylWall";

/** Browse your library as a wall of record sleeves, with calm motion that respects reduced-motion settings. */
const vinylWall: Plugin = {
  manifest: {
    id: "cadence.vinyl-wall",
    name: "Vinyl wall",
    version: "1.0.0",
    description: "An album-shelf view of your library with gentle motion.",
    author: "Cadence",
    capabilities: ["ui.sidebar"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: VINYL_ITEM_ID, label: "Vinyl wall", icon: <ShelfIcon />, render: () => <VinylWall /> });
  },
};

export default vinylWall;