import type { Plugin } from "@/plugins/types";
import { CloudIcon } from "../_social/ui";
import { attach, useRadio } from "./store";
import { WEATHER_ITEM_ID, WeatherRadioPage } from "./WeatherRadioPage";

/**
 * Weather radio: a queue from your own library that suits the weather and time of day. Weather comes from
 * Open-Meteo (no key) and only after you opt in; only rounded coordinates are sent, to api.open-meteo.com.
 * Genre matching uses the optional server plugin cadence.weather-radio; the AI DJ is optional too.
 */
const weatherRadio: Plugin = {
  manifest: {
    id: "cadence.weather-radio",
    name: "Weather radio",
    version: "1.0.0",
    description: "A queue from your library that suits the weather and the time of day. Weather by Open-Meteo, opt-in.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "network.outbound", "storage", "player.queue"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    attach({ fetch: ctx.fetch, storage: ctx.storage, play: (tracks, index) => ctx.player.playTracks(tracks, index) });
    useRadio.getState().load();
    ctx.registerSidebarItem({ id: WEATHER_ITEM_ID, label: "Weather radio", icon: <CloudIcon />, render: () => <WeatherRadioPage /> });
  },
};

export default weatherRadio;