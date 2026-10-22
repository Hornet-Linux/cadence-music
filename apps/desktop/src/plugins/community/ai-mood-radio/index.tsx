import type { Plugin } from "../../types";
import { useDj } from "@/features/dj/djStore";
import { setFeedbackSource } from "@/features/dj/hooks";
import { WavesIcon } from "@/ui/icons";
import { RadioPage } from "./RadioPage";
import { feedbackNotes, ListenTracker } from "./mood";
import { useRadio } from "./store";

const SPOKEN_KEY = "spoken";
let saveSpoken: (() => void) | null = null;
/** What the listener did with the regular DJ's songs. Kept across plugin rebuilds. */
const djListens = new ListenTracker((id) => !!useDj.getState().intros[id]);

/** A radio for a mood or activity that keeps the queue topped up and learns from skips. */
const plugin: Plugin = {
  manifest: {
    id: "cadence.ai-mood-radio",
    name: "Mood radio",
    version: "1.0.0",
    description: "Focus, workout, sleep, party or commute radio. Keeps the queue filled and changes direction when you skip.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "player.read", "player.queue", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    saveSpoken?.();
    const saved = ctx.storage.get<boolean>(SPOKEN_KEY);
    useRadio.getState().setSpoken(saved === true);
    saveSpoken = useRadio.subscribe((s, prev) => {
      if (s.spoken !== prev.spoken) ctx.storage.set(SPOKEN_KEY, s.spoken);
    });

    ctx.registerSidebarItem({ id: "ai-mood-radio", label: "Mood radio", icon: <WavesIcon size={22} />, render: () => <RadioPage /> });

    // The radio learns from skips; the regular AI DJ gets the same skip-aware notes.
    setFeedbackSource(() => feedbackNotes(djListens.reactions));
    ctx.onPlayback((e) => {
      djListens.handle(e);
      useRadio.getState().onPlayback(e);
    });
  },
  deactivate() {
    saveSpoken?.();
    saveSpoken = null;
    setFeedbackSource(null);
    const radio = useRadio.getState();
    if (radio.status !== "off") radio.stop();
  },
};

export default plugin;
