import { planDjSet } from "@/features/dj/dj";
import { requireProvider } from "@/features/dj/ask";
import { useDj } from "@/features/dj/djStore";
import { getHostPersona } from "@/features/dj/hooks";
import { everywhereSource } from "@/features/dj/multiSource";
import { speakIntro, stopSpeaking } from "@/features/dj/voice";
import { usePlayer } from "@/player/playerStore";
import { createRadioStore, type PlayerPort } from "./radio";

const player: PlayerPort = {
  snapshot: () => {
    const { queue, index } = usePlayer.getState();
    return { queue, index };
  },
  play: (tracks) => usePlayer.getState().playQueue(tracks, 0),
  append: (tracks) => usePlayer.setState((p) => ({ queue: [...p.queue, ...tracks] })),
  async replaceUpcoming(tracks) {
    const { queue, index } = usePlayer.getState();
    usePlayer.setState({ queue: [...queue.slice(0, index + 1), ...tracks] });
    await usePlayer.getState().next();
  },
};

/** The mood radio, wired to the real player, the DJ's set planner and the listener's sources. */
export const useRadio = createRadioStore({
  provider: requireProvider,
  profile: () => everywhereSource.taste(),
  plan: (ref, profile, opts) => planDjSet(ref, profile, opts, everywhereSource),
  player,
  stopDj: () => {
    const dj = useDj.getState();
    if (dj.status !== "idle") dj.stop();
  },
  speak: speakIntro,
  stopSpeaking,
  hostStyle: () => getHostPersona()?.style,
  now: () => Date.now(),
});
