import type { Plugin } from "../../types";
import { SparkleIcon } from "@/ui/icons";
import { PersonalitiesPanel } from "./PersonalitiesPanel";
import { activatePersonality, deactivatePersonality } from "./store";

/** Pick the DJ's host: warm, dry, calm, hype, minimal, or one you write. */
const plugin: Plugin = {
  manifest: {
    id: "cadence.dj-personalities",
    name: "DJ personalities",
    version: "1.0.0",
    description: "Choose how the AI DJ talks and sounds, or write your own host.",
    author: "Cadence",
    capabilities: ["ui.settings", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    activatePersonality(ctx.storage);
    ctx.registerSettingsPanel({
      id: "dj-personalities",
      title: "DJ personalities",
      description: "How the AI DJ talks: warm, dry, calm, hype, minimal, or your own.",
      icon: <SparkleIcon size={16} />,
      keywords: ["dj", "voice", "host", "persona", "intro", "tone"],
      render: () => <PersonalitiesPanel />,
    });
  },
  deactivate() {
    deactivatePersonality();
  },
};

export default plugin;
