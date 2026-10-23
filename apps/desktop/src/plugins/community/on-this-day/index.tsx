import type { Plugin } from "@/plugins/types";
import "../_social/base.css";
import { OnThisDayWidget } from "./Widget";

/** A Home widget that shows what you were listening to on this date in earlier years. */
const onThisDay: Plugin = {
  manifest: {
    id: "cadence.on-this-day",
    name: "On this day",
    version: "1.0.0",
    description: "Home widget: what you listened to a year ago today, and on this date in earlier years.",
    author: "Cadence",
    capabilities: ["ui.home.widget", "player.queue"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    const play = (tracks: Parameters<typeof ctx.player.playTracks>[0], index: number) => void ctx.player.playTracks(tracks, index);
    ctx.registerHomeWidget({ id: "on-this-day", title: "On this day", weight: 15, render: () => <OnThisDayWidget play={play} /> });
  },
};

export default onThisDay;