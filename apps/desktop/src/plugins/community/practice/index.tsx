import type { Plugin } from "@/plugins/types";
import { LoopIcon } from "../_social/ui";
import { attach, startEngine, stopEngine, usePractice } from "./engine";
import { PRACTICE_ITEM_ID, PracticePage } from "./PracticePage";

/**
 * Practice mode: an A-B loop, slow-down (pitch kept) and a count-in click. It only uses supported player
 * APIs: position and seek from `ctx.player`, and the player's tuning settings for the speed and for holding
 * the track while a loop is on (so crossfade and gapless never carry a loop into the next song). Loops and
 * count-ins work with every source; slow-down only with plain media (your server and local files), not
 * Spotify or Apple Music, which play in their own players.
 */
const practice: Plugin = {
  manifest: {
    id: "cadence.practice",
    name: "Practice mode",
    version: "1.0.0",
    description: "A-B loop, slow-down and count-in for practising along.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "player.read", "player.control", "commands"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    attach(ctx);
    startEngine();
    ctx.registerSidebarItem({ id: PRACTICE_ITEM_ID, label: "Practice", icon: <LoopIcon />, render: () => <PracticePage /> });
    ctx.registerCommand({ id: "practice.mark-a", title: "Practice: set loop start (A) here", run: () => usePractice.getState().markA() });
    ctx.registerCommand({ id: "practice.mark-b", title: "Practice: set loop end (B) here", run: () => usePractice.getState().markB() });
    ctx.registerCommand({ id: "practice.toggle-loop", title: "Practice: turn the loop on or off", run: () => usePractice.getState().toggleLoop() });
  },
  deactivate() {
    stopEngine();
  },
};

export default practice;