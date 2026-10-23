import type { Plugin } from "../../types";
import { TasteWidget } from "./TasteWidget";
import { useTaste } from "./store";

/** Your taste in three paragraphs, written by your AI from a summary of your listening. Opt-in. */
const plugin: Plugin = {
  manifest: {
    id: "cadence.ai-taste-summary",
    name: "Taste summary",
    version: "1.0.0",
    description: "Your taste in three paragraphs. Only a summary of counts is sent to your AI provider, and only when you press the button.",
    author: "Cadence",
    capabilities: ["ui.home.widget", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    useTaste.getState().load(ctx.storage);
    ctx.registerHomeWidget({ id: "ai-taste-summary", title: "Your taste in three paragraphs", weight: 5, render: () => <TasteWidget /> });
  },
  deactivate() {
    useTaste.getState().load(null);
  },
};

export default plugin;
