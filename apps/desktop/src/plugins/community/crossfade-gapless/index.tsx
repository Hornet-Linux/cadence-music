import { Toggle } from "@/features/settings/controls";
import { MAX_CROSSFADE_SEC, useTuning } from "@/player/tuning";
import type { Plugin } from "@/plugins/types";
import { Chips, Note, Row, Section, Slider } from "../_audio-kit/ui";
import { clamp, createPrefs } from "../_audio-kit/prefs";

export interface TransitionPrefs {
  /** 0 = off. */
  crossfadeSec: number;
  gapless: boolean;
}

export const transitionPrefs = createPrefs<TransitionPrefs>(
  "settings",
  { crossfadeSec: 0, gapless: true },
  (v) => ({
    crossfadeSec: Math.round(clamp(v.crossfadeSec, 0, MAX_CROSSFADE_SEC) * 2) / 2,
    gapless: v.gapless !== false,
  }),
);

/** Hand the saved choices to the player (it owns the actual timing). */
export function applyToPlayer(p: TransitionPrefs = transitionPrefs.get()) {
  useTuning.getState().set({ crossfadeSec: p.crossfadeSec, gapless: p.gapless });
}

export const fadeLabel = (sec: number) => (sec <= 0 ? "Off" : `${sec % 1 === 0 ? sec : sec.toFixed(1)} s`);

const QUICK = [0, 2, 4, 6, 8, 12];

export function TransitionPanel() {
  const p = transitionPrefs.use();
  const set = (patch: Partial<TransitionPrefs>) => {
    transitionPrefs.set(patch);
    applyToPlayer();
  };
  return (
    <div className="ax">
      <Section title="Crossfade">
        <Slider
          label="Overlap between tracks"
          value={p.crossfadeSec}
          min={0}
          max={MAX_CROSSFADE_SEC}
          step={0.5}
          format={fadeLabel}
          onChange={(crossfadeSec) => set({ crossfadeSec })}
          hint="The next song fades in while the current one fades out."
        />
        <Chips
          label="Crossfade length"
          options={QUICK.map((s) => ({ value: s, label: fadeLabel(s) }))}
          value={QUICK.includes(p.crossfadeSec) ? p.crossfadeSec : null}
          onChange={(crossfadeSec) => set({ crossfadeSec })}
        />
      </Section>

      <Section title="Gapless">
        <Row
          title="Gapless playback"
          description="Loads the next song ahead of time and starts it the moment this one ends, with no pause. With crossfade on, the next song is also loaded early."
        >
          <Toggle on={p.gapless} onChange={(gapless) => set({ gapless })} label="Gapless playback" />
        </Row>
      </Section>

      <Note>
        Works for music Cadence plays itself (your server and files on this device). Spotify and Apple Music play inside their
        own players, so they keep their usual short pause between songs. Pressing next skips straight to the following song,
        and the sleep timer&apos;s &quot;end of track&quot; mode never blends into another song.
      </Note>
    </div>
  );
}

const crossfadePlugin: Plugin = {
  manifest: {
    id: "cadence.crossfade-gapless",
    name: "Crossfade & Gapless",
    version: "1.0.0",
    description: "Blend songs together, or play albums with no gap between tracks.",
    author: "Cadence",
    capabilities: ["ui.settings", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    transitionPrefs.bind(ctx.storage);
    applyToPlayer();
    ctx.registerSettingsPanel({
      id: "crossfade-gapless",
      title: "Crossfade & Gapless",
      description: "Blend songs together or remove the gap between them.",
      keywords: ["crossfade", "gapless", "fade", "transition", "overlap", "album"],
      render: () => <TransitionPanel />,
    });
  },
  deactivate() {
    useTuning.getState().reset(["crossfadeSec", "gapless"]);
  },
};

export default crossfadePlugin;
