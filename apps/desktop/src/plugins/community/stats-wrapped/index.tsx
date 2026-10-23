import type { Plugin } from "@/plugins/types";
import { ChartIcon } from "../_social/ui";
import { STATS_ITEM_ID, StatsPage, StatsWidget } from "./StatsPage";

/**
 * Listening stats and a "year in review", built from your listening history (the same history that
 * powers Home). Top artists, songs and albums, when you listen, streaks, new-vs-familiar music, a
 * summary card you can download or share, and a small Home widget.
 */
const statsWrapped: Plugin = {
  manifest: {
    id: "cadence.stats-wrapped",
    name: "Listening stats and year in review",
    version: "1.0.0",
    description: "Top artists, songs and albums, listening hours, streaks and a shareable year-in-review card.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "ui.home.widget"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: STATS_ITEM_ID, label: "Stats", icon: <ChartIcon />, render: () => <StatsPage /> });
    ctx.registerHomeWidget({ id: "stats-week", title: "Your week in music", weight: 20, render: () => <StatsWidget /> });
  },
};

export default statsWrapped;