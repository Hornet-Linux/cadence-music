import type { Plugin } from "../../types";
import { WavesIcon } from "@/ui/icons";
import { TranscodePanel } from "./TranscodePanel";

/** Pick a streaming quality for this device; the server converts songs on the fly. */
const transcodePlugin: Plugin = {
  manifest: {
    id: "cadence.transcode",
    name: "Streaming quality",
    version: "1.0.0",
    description:
      "Stream your server library in a smaller format (Opus, AAC or MP3) to save data on mobile. The server converts songs on the fly and keeps them cached. Needs the matching server plugin to be switched on.",
    author: "Cadence",
    capabilities: ["ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "streaming-quality",
      title: "Streaming quality",
      description: "Choose how songs from your server are streamed on this device.",
      icon: <WavesIcon size={19} />,
      keywords: ["transcode", "opus", "aac", "mp3", "bitrate", "data", "mobile"],
      render: () => <TranscodePanel />,
    });
  },
};

export default transcodePlugin;
