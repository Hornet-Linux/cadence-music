import { Segmented } from "@/features/settings/controls";
import type { AudioEffect, Plugin } from "@/plugins/types";
import { createPrefs } from "../_audio-kit/prefs";
import { Note, Section, Slider } from "../_audio-kit/ui";
import { DEFAULT_STEREO, gainsFor, sanitizeStereo, type StereoMode, type StereoSettings } from "./crossfeed";

export const stereoPrefs = createPrefs<StereoSettings>("settings", DEFAULT_STEREO, sanitizeStereo);

interface Live {
  ctx: AudioContext;
  direct: GainNode[];
  cross: GainNode[];
  lowpass: BiquadFilterNode[];
  delay: DelayNode[];
}
let live: Live | null = null;

export function applyLive() {
  if (!live) return;
  const g = gainsFor(stereoPrefs.get());
  const t = live.ctx.currentTime;
  for (const n of live.direct) n.gain.setTargetAtTime(g.direct, t, 0.03);
  for (const n of live.cross) n.gain.setTargetAtTime(g.cross, t, 0.03);
  for (const n of live.lowpass) n.frequency.setTargetAtTime(g.cutoff, t, 0.03);
  for (const n of live.delay) n.delayTime.setTargetAtTime(g.delay, t, 0.03);
}

stereoPrefs.use.subscribe(applyLive);

/** splitter -> per ear: direct + (other ear -> low-pass -> delay -> gain) -> merger. */
export const stereoEffect: AudioEffect = {
  id: "cadence.crossfeed",
  label: "Crossfeed / stereo width",
  order: 30,
  create(ctx) {
    const g = gainsFor(stereoPrefs.get());
    const input = ctx.createGain();
    // Force a stereo signal (mono sources are copied to both ears).
    input.channelCount = 2;
    input.channelCountMode = "explicit";
    input.channelInterpretation = "speakers";
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    input.connect(splitter);

    const direct: GainNode[] = [];
    const cross: GainNode[] = [];
    const lowpass: BiquadFilterNode[] = [];
    const delay: DelayNode[] = [];
    for (let ear = 0; ear < 2; ear++) {
      const other = 1 - ear;
      const d = ctx.createGain();
      d.gain.value = g.direct;
      splitter.connect(d, ear);
      d.connect(merger, 0, ear);

      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = g.cutoff;
      const dl = ctx.createDelay(0.01);
      dl.delayTime.value = g.delay;
      const c = ctx.createGain();
      c.gain.value = g.cross;
      splitter.connect(lp, other);
      lp.connect(dl);
      dl.connect(c);
      c.connect(merger, 0, ear);

      direct.push(d);
      cross.push(c);
      lowpass.push(lp);
      delay.push(dl);
    }
    const mine: Live = { ctx, direct, cross, lowpass, delay };
    live = mine;
    return {
      input,
      output: merger,
      dispose() {
        if (live === mine) live = null;
      },
    };
  },
};

const MODES: { value: StereoMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "crossfeed", label: "Crossfeed" },
  { value: "widen", label: "Wider" },
];

export function StereoPanel() {
  const s = stereoPrefs.use();
  return (
    <div className="ax">
      <Section title="Mode">
        <Segmented label="Stereo mode" value={s.mode} options={MODES} onChange={(mode) => stereoPrefs.set({ mode })} />
        <p className="ax-hint" aria-live="polite">
          {s.mode === "off" && "Sound is passed through unchanged."}
          {s.mode === "crossfeed" && "Blends a little of each side into the other so headphones sound more like speakers."}
          {s.mode === "widen" && "Makes the stereo image broader. Best on speakers or when music feels narrow."}
        </p>
      </Section>

      {s.mode === "crossfeed" && (
        <Section title="Crossfeed">
          <Slider
            label="Strength"
            value={s.feed}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(feed) => stereoPrefs.set({ feed })}
            hint="Start low. Old records with instruments panned hard left and right benefit most."
          />
        </Section>
      )}
      {s.mode === "widen" && (
        <Section title="Width">
          <Slider
            label="Stereo width"
            value={s.width}
            min={0}
            max={2}
            step={0.05}
            format={(v) => (v === 0 ? "Mono" : v === 1 ? "Normal" : `${Math.round(v * 100)}%`)}
            onChange={(width) => stereoPrefs.set({ width })}
            hint="100% is the original. Below that narrows towards mono; above widens."
          />
        </Section>
      )}

      <Note>Use headphones for crossfeed. It affects music Cadence plays itself, not Spotify or Apple Music.</Note>
    </div>
  );
}

const crossfeedPlugin: Plugin = {
  manifest: {
    id: "cadence.crossfeed",
    name: "Crossfeed & Stereo Width",
    version: "1.0.0",
    description: "Headphone crossfeed for a more natural, speaker-like sound, or a simple stereo widener.",
    author: "Cadence",
    capabilities: ["audio.dsp", "ui.settings", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    stereoPrefs.bind(ctx.storage);
    ctx.registerAudioEffect(stereoEffect);
    ctx.registerSettingsPanel({
      id: "crossfeed",
      title: "Crossfeed & Stereo Width",
      description: "Softer headphone stereo, or a wider image.",
      keywords: ["headphones", "stereo", "widener", "spatial", "bauer", "mono"],
      render: () => <StereoPanel />,
    });
  },
};

export default crossfeedPlugin;
