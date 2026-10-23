import { useEffect, useState } from "react";
import type { PluginContext, Plugin } from "@/plugins/types";
import { useTuning } from "@/player/tuning";
import { createPrefs, clamp } from "../_audio-kit/prefs";
import { Chips, Note, Section, Slider } from "../_audio-kit/ui";
import { SleepController, formatRemaining, useSleep } from "./sleep";

export const sleepPrefs = createPrefs<{ fadeSec: number; lastMinutes: number }>(
  "settings",
  { fadeSec: 20, lastMinutes: 30 },
  (v) => ({ fadeSec: Math.round(clamp(v.fadeSec, 0, 60)), lastMinutes: Math.round(clamp(v.lastMinutes, 1, 600)) }),
);

let player: PluginContext["player"] | null = null;

export const controller = new SleepController({
  player: () => {
    if (!player) throw new Error("The player is not ready yet");
    return player;
  },
  fadeSec: () => sleepPrefs.get().fadeSec,
});

const MINUTES = [5, 10, 15, 30, 45, 60, 90];

export function startMinutes(minutes: number) {
  sleepPrefs.set({ lastMinutes: minutes });
  controller.startMinutes(minutes);
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function SleepPanel() {
  const active = useSleep((s) => s.active);
  const prefs = sleepPrefs.use();
  const now = useNow(!!active);
  const [custom, setCustom] = useState("");

  const customMinutes = Number(custom);
  const customOk = Number.isFinite(customMinutes) && customMinutes >= 1 && customMinutes <= 600;

  return (
    <div className="ax">
      <Section title="Status">
        {active ? (
          <div className="ax-inline" role="status" aria-live="polite">
            <span className="ax-status">
              {active.kind === "track"
                ? "Stopping when this song ends"
                : `Pausing in ${formatRemaining((active.endsAt ?? now) - now)}`}
            </span>
            <button type="button" className="ax-btn" onClick={() => controller.cancel()}>
              Cancel timer
            </button>
          </div>
        ) : (
          <p className="ax-hint">No timer is running.</p>
        )}
      </Section>

      <Section title="Pause after">
        <Chips
          label="Sleep timer length in minutes"
          options={MINUTES.map((m) => ({ value: m, label: m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min` }))}
          value={active?.kind === "minutes" ? active.minutes : null}
          onChange={startMinutes}
        />
        <div className="ax-inline">
          <input
            className="ax-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={600}
            placeholder="Minutes"
            aria-label="Custom minutes"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && customOk && startMinutes(customMinutes)}
          />
          <button type="button" className="ax-btn" disabled={!customOk} onClick={() => startMinutes(customMinutes)}>
            Start
          </button>
        </div>
        <button type="button" className="ax-btn" onClick={() => controller.startEndOfTrack()}>
          Stop at the end of this song
        </button>
      </Section>

      <Section title="Fade out">
        <Slider
          label="Fade the volume down over"
          value={prefs.fadeSec}
          min={0}
          max={60}
          step={5}
          format={(v) => (v === 0 ? "No fade" : `${v} s`)}
          onChange={(fadeSec) => sleepPrefs.set({ fadeSec })}
          hint="The volume eases down before playback stops. Your volume setting is not changed."
        />
      </Section>

      <Note>The timer runs while Cadence is open. It covers music Cadence plays and also Spotify and Apple Music playback.</Note>
    </div>
  );
}

const sleepPlugin: Plugin = {
  manifest: {
    id: "cadence.sleep-timer",
    name: "Sleep Timer",
    version: "1.0.0",
    description: "Stop the music after a set time or at the end of a song, with a gentle fade-out.",
    author: "Cadence",
    capabilities: ["ui.settings", "commands", "storage", "player.read", "player.control"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    sleepPrefs.bind(ctx.storage);
    player = ctx.player;
    ctx.registerSettingsPanel({
      id: "sleep-timer",
      title: "Sleep Timer",
      description: "Fall asleep to music, then let it fade out.",
      keywords: ["sleep", "timer", "bedtime", "stop", "fade", "night"],
      render: () => <SleepPanel />,
    });
    for (const m of [15, 30, 60]) {
      ctx.registerCommand({
        id: `sleep-${m}`,
        title: `Sleep timer: ${m === 60 ? "1 hour" : `${m} minutes`}`,
        keywords: ["sleep", "timer", "stop"],
        run: () => startMinutes(m),
      });
    }
    ctx.registerCommand({
      id: "sleep-track",
      title: "Sleep timer: stop at end of this song",
      keywords: ["sleep", "timer", "stop", "track"],
      run: () => controller.startEndOfTrack(),
    });
    ctx.registerCommand({
      id: "sleep-cancel",
      title: "Cancel sleep timer",
      keywords: ["sleep", "timer", "cancel"],
      run: () => controller.cancel(),
    });
  },
  deactivate() {
    controller.cancel();
    useTuning.getState().reset(["masterGain", "stopAfterTrack"]);
  },
};

export default sleepPlugin;
