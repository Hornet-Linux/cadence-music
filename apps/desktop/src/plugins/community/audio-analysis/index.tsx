import type { Plugin } from "../../types";
import { SlidersIcon } from "@/ui/icons";
import { AnalysisPanel } from "../_serverlib/AnalysisPanel";

/** Progress and controls for the server's tempo, energy and key analysis. */
const audioAnalysisPlugin: Plugin = {
  manifest: {
    id: "cadence.audio-analysis",
    name: "Tempo, energy and key",
    version: "1.0.0",
    description:
      "Estimates the tempo (BPM), energy and musical key of each track on your server, for the AI DJ and smart playlists. Estimates, not studio-grade. Needs the matching server plugin to be switched on.",
    author: "Cadence",
    capabilities: ["ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "audio-analysis",
      title: "Tempo, energy and key",
      description: "Estimate BPM, energy and key for the AI DJ and smart playlists.",
      icon: <SlidersIcon size={19} />,
      keywords: ["bpm", "tempo", "key", "camelot", "energy", "dj"],
      render: () => (
        <AnalysisPanel
          base="api/audio-analysis"
          noun="audio analysis"
          what="One minute of each track is analysed on the server. Tempo can come out at half or double speed for some music; treat the values as good guesses."
        />
      ),
    });
  },
};

export default audioAnalysisPlugin;
