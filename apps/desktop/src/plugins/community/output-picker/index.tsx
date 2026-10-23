import { useNav } from "@/app/navStore";
import type { Plugin } from "../../types";
import { OutputPicker } from "./OutputPicker";

const PAGE_ID = "play-on";

/** A speaker-and-screen icon, in the same stroke style as the app icons. */
function PlayOnIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

/** "Play on...": pick where the music comes out. Other plugins register the places; this lists them. */
const outputPicker: Plugin = {
  manifest: {
    id: "cadence.output-picker",
    name: "Play on...",
    version: "1.0.0",
    description: "Choose where music plays: this device or any speaker, TV or other Cadence player that a device plugin finds.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "commands"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: PAGE_ID, label: "Play on", icon: <PlayOnIcon />, render: () => <OutputPicker /> });
    ctx.registerCommand({
      id: "open-play-on",
      title: "Play on...",
      keywords: ["output", "cast", "speaker", "device"],
      run: () => useNav.getState().navigate({ kind: "plugin", itemId: PAGE_ID }),
    });
  },
};

export default outputPicker;
