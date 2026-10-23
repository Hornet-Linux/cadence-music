import type { Plugin } from "../../types";
import { SnapcastPage } from "./SnapcastPage";

function SnapcastIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <circle cx="12" cy="14" r="3.2" />
      <circle cx="12" cy="7.5" r="0.9" />
    </svg>
  );
}

/** Control an existing Snapcast server: groups, clients, volume, mute and which stream plays. */
const snapcast: Plugin = {
  manifest: {
    id: "cadence.snapcast",
    name: "Snapcast",
    version: "1.0.0",
    description:
      "See and control your Snapcast multi-room audio server: volume, mute and stream per room. It does not stream Cadence audio into Snapcast. Needs the Snapcast server plugin turned on by your server admin.",
    author: "Cadence",
    capabilities: ["ui.sidebar", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: "snapcast", label: "Snapcast", icon: <SnapcastIcon />, render: () => <SnapcastPage /> });
  },
};

export default snapcast;
