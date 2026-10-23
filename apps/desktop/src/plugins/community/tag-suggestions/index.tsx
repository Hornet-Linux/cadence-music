import type { Plugin } from "../../types";
import { ListIcon } from "@/ui/icons";
import { TagSuggestionsPage } from "./TagSuggestionsPage";

/** Review and accept proposed tag clean-ups; the server stores accepted fixes as overlays. */
const tagSuggestionsPlugin: Plugin = {
  manifest: {
    id: "cadence.tag-suggestions",
    name: "Tag suggestions",
    version: "1.0.0",
    description:
      "Suggests fixes for capitalisation, feat. credits, missing album artists and track numbers. Accepted fixes are saved on the server, never in your files. Needs the matching server plugin to be switched on.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({
      id: "tag-suggestions",
      label: "Tag suggestions",
      icon: <ListIcon />,
      render: () => <TagSuggestionsPage />,
    });
  },
};

export default tagSuggestionsPlugin;
