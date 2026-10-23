import { create } from "zustand";
import { Toggle } from "@/features/settings/controls";
import { useTuning } from "@/player/tuning";
import type { Plugin } from "@/plugins/types";
import { Chips, Note, Row, Section, Slider } from "../_audio-kit/ui";
import { SPEED_PRESETS, MAX_RATE, MIN_RATE, clampRate, describePitch, formatRate, matchSpeedPreset, stepRate } from "./speed";

/** Speed lives for this session only: it is not saved, so the app always starts at normal speed. */
export const useSpeed = create<{ rate: number; preservePitch: boolean }>(() => ({ rate: 1, preservePitch: true }));

export function applySpeed() {
  const { rate, preservePitch } = useSpeed.getState();
  useTuning.getState().set({ rate, preservePitch });
}

export function setSpeed(patch: Partial<{ rate: number; preservePitch: boolean }>) {
  const next = { ...patch };
  if (next.rate !== undefined) next.rate = clampRate(next.rate);
  useSpeed.setState(next);
  applySpeed();
}

export function SpeedPanel() {
  const { rate, preservePitch } = useSpeed();
  const preset = matchSpeedPreset(rate, preservePitch);
  const hint = SPEED_PRESETS.find((p) => p.id === preset)?.hint;
  return (
    <div className="ax">
      <Section title="Presets">
        <Chips
          label="Speed presets"
          options={SPEED_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
          value={preset}
          onChange={(id) => {
            const p = SPEED_PRESETS.find((x) => x.id === id);
            if (p) setSpeed({ rate: p.rate, preservePitch: p.preservePitch });
          }}
        />
        <p className="ax-hint" aria-live="polite">
          {hint ?? "Custom speed"}
        </p>
      </Section>

      <Section title="Speed">
        <Slider
          label="Playback speed"
          value={rate}
          min={MIN_RATE}
          max={MAX_RATE}
          step={0.05}
          format={formatRate}
          onChange={(r) => setSpeed({ rate: r })}
        />
        <Row title="Keep the pitch" description={describePitch(rate, preservePitch)}>
          <Toggle on={preservePitch} onChange={(p) => setSpeed({ preservePitch: p })} label="Keep the pitch" />
        </Row>
        <button type="button" className="ax-btn quiet" disabled={rate === 1 && preservePitch} onClick={() => setSpeed({ rate: 1, preservePitch: true })}>
          Back to normal
        </button>
      </Section>

      <Note>
        The speed is for this session only and returns to normal the next time Cadence starts. It works for music Cadence plays
        itself; Spotify and Apple Music always play at normal speed.
      </Note>
    </div>
  );
}

const speedPlugin: Plugin = {
  manifest: {
    id: "cadence.speed-pitch",
    name: "Speed & Pitch",
    version: "1.0.0",
    description: "Play faster or slower, with or without changing the pitch. Includes slowed and nightcore presets.",
    author: "Cadence",
    capabilities: ["ui.settings", "commands"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    applySpeed();
    ctx.registerSettingsPanel({
      id: "speed-pitch",
      title: "Speed & Pitch",
      description: "Slowed, nightcore, or anything between 0.5x and 2x.",
      keywords: ["tempo", "nightcore", "slowed", "playback rate", "pitch"],
      render: () => <SpeedPanel />,
    });
    ctx.registerCommand({
      id: "speed-up",
      title: "Speed up playback",
      keywords: ["faster", "tempo"],
      run: () => setSpeed({ rate: stepRate(useSpeed.getState().rate, 1) }),
    });
    ctx.registerCommand({
      id: "slow-down",
      title: "Slow down playback",
      keywords: ["slower", "tempo"],
      run: () => setSpeed({ rate: stepRate(useSpeed.getState().rate, -1) }),
    });
    ctx.registerCommand({
      id: "reset-speed",
      title: "Reset playback speed",
      keywords: ["normal", "tempo"],
      run: () => setSpeed({ rate: 1, preservePitch: true }),
    });
  },
  deactivate() {
    useTuning.getState().reset(["rate", "preservePitch"]);
  },
};

export default speedPlugin;
