import type { Plugin } from "../../types";
import { WavesIcon } from "@/ui/icons";
import { AnalysisPanel } from "../_serverlib/AnalysisPanel";

/** Progress and controls for the server's loudness (ReplayGain style) analysis. */
const loudnessPlugin: Plugin = {
  manifest: {
    id: "cadence.loudness",
    name: "Loudness analysis",
    version: "1.0.0",
    description:
      "Measures how loud each track on your server is (EBU R128, ReplayGain style) in the background. Volume normalisation can use the result. Needs the matching server plugin to be switched on.",
    author: "Cadence",
    capabilities: ["ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "loudness",
      title: "Loudness analysis",
      description: "Measure every track on your server so volume can be levelled.",
      icon: <WavesIcon size={19} />,
      keywords: ["replaygain", "normalize", "volume", "lufs", "r128"],
      render: () => (
        <AnalysisPanel
          base="api/loudness"
          noun="loudness analysis"
          what="Each track is listened to once on the server (at low priority) and its loudness is saved in the server database. Your music files are never changed."
        />
      ),
    });
  },
};

export default loudnessPlugin;
