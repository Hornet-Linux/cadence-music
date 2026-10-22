import type { Plugin } from "@/plugins/types";
import { LoopIcon } from "../_social/ui";
import { attach, startEngine, stopEngine, usePractice } from "./engine";
import { PRACTICE_ITEM_ID, PracticePage } from "./PracticePage";

/**
 * Practice mode: an A-B loop, slow-down (pitch kept) and a count-in click. Loops and count-ins work with
 * every source. Slow-down needs the player's own audio element, so it works for songs from your server
 * and local files but not for Spotify or Apple Music, which play in their own players.
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
    attach(ctx.player);
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