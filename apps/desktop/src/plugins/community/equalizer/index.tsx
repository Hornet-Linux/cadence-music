import type { Plugin } from "@/plugins/types";
import { EqPanel } from "./EqPanel";
import { eqEffect, eqPrefs } from "./engine";

const equalizerPlugin: Plugin = {
  manifest: {
    id: "cadence.equalizer",
    name: "Equalizer",
    version: "1.0.0",
    description: "A 10-band equalizer with presets, a preamp and your own saved curves.",
    author: "Cadence",
    capabilities: ["audio.dsp", "ui.settings", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    eqPrefs.bind(ctx.storage);
    ctx.registerAudioEffect(eqEffect);
    ctx.registerSettingsPanel({
      id: "equalizer",
      title: "Equalizer",
      description: "10 bands, presets and a preamp.",
      keywords: ["eq", "bass", "treble", "sound", "audio", "preset", "loudness"],
      render: () => <EqPanel />,
    });
  },
};

export default equalizerPlugin;
