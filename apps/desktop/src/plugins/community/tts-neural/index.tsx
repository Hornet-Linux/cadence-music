import type { Plugin } from "../../types";
import { VolumeIcon } from "@/ui/icons";
import { TtsPanel } from "./TtsPanel";
import { activateTts, deactivateTts } from "./store";

/** Natural-sounding voices for the DJ's intros from an OpenAI-compatible speech server. */
const plugin: Plugin = {
  manifest: {
    id: "cadence.tts-neural",
    name: "Neural voices",
    version: "1.0.0",
    description: "Speak the DJ's intros with OpenAI, Kokoro, Piper or any OpenAI-compatible speech server. Falls back to system voices.",
    author: "Cadence",
    capabilities: ["ui.settings", "storage", "network.outbound"],
    apiRange: "^1.0.0",
  },
  async activate(ctx) {
    await activateTts(ctx.storage, ctx.fetch);
    ctx.registerSettingsPanel({
      id: "tts-neural",
      title: "Neural voices",
      description: "Natural voices for the AI DJ from a speech server (OpenAI, Kokoro, Piper).",
      icon: <VolumeIcon size={16} />,
      keywords: ["tts", "speech", "voice", "piper", "kokoro", "openai", "dj", "audio"],
      render: () => <TtsPanel />,
    });
  },
  deactivate() {
    deactivateTts();
  },
};

export default plugin;
