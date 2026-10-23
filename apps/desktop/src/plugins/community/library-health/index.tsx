import type { Plugin } from "../../types";
import { SlidersIcon } from "@/ui/icons";
import { LibraryHealthPage } from "./LibraryHealthPage";
import "./style.css";

/** Admin report on the server's library: duplicates, missing tags and artwork, unreadable files. */
const libraryHealthPlugin: Plugin = {
  manifest: {
    id: "cadence.library-health",
    name: "Library health",
    version: "1.0.0",
    description:
      "Finds duplicate tracks, missing artwork and tags, and unreadable files in your server library. Needs the matching server plugin to be switched on.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({
      id: "library-health",
      label: "Library health",
      icon: <SlidersIcon />,
      render: () => <LibraryHealthPage />,
    });
  },
};

export default libraryHealthPlugin;
