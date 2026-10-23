import type { Plugin } from "../../types";

/**
 * AirPlay is not implemented. This plugin exists only to say so plainly, in the place people look for it, and to
 * point at what does work. It registers no output and never pretends to find AirPlay devices.
 */
function AirPlayNotice() {
  return (
    <div className="stack">
      <p className="notice warn">
        <strong>AirPlay output is not available in Cadence.</strong> Nothing here sends audio to AirPlay speakers, Apple TVs or HomePods.
      </p>
      <p className="muted small">
        AirPlay is a closed Apple protocol. Current devices need AirPlay 2 pairing and encryption that cannot be done reliably without
        Apple&apos;s own software, and an unreliable version would drop out mid-song. So it is left out rather than faked.
      </p>
      <p className="muted small">What works today:</p>
      <ul className="muted small" style={{ paddingLeft: "1.2em" }}>
        <li>On a Mac, pick the AirPlay speaker as the sound output in the menu bar. Cadence plays through whatever the Mac is set to.</li>
        <li>On an iPhone or iPad, use the AirPlay button in Control Center while Cadence is playing.</li>
        <li>Chromecast, DLNA and Sonos, and Snapcast speakers are supported through their own plugins.</li>
        <li>If you run a bridge that shows AirPlay speakers as UPnP devices (for example AirConnect), the DLNA plugin can control them. That bridge is separate software and not part of Cadence.</li>
      </ul>
    </div>
  );
}

const airplay: Plugin = {
  manifest: {
    id: "cadence.airplay",
    name: "AirPlay (not available)",
    version: "1.0.0",
    description: "AirPlay output is not available. This only explains why and what to use instead.",
    author: "Cadence",
    capabilities: ["ui.settings"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "airplay",
      title: "AirPlay (not available)",
      description: "Why there is no AirPlay output, and what to use instead.",
      keywords: ["apple", "homepod", "raop", "airplay"],
      render: () => <AirPlayNotice />,
    });
  },
};

export default airplay;
