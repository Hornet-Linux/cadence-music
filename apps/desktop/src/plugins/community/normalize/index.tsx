import { create } from "zustand";
import { Toggle, Segmented } from "@/features/settings/controls";
import type { AudioEffect, Plugin } from "@/plugins/types";
import type { Track } from "@/shared/types";
import { createPrefs } from "../_audio-kit/prefs";
import { Note, Row, Section, Slider } from "../_audio-kit/ui";
import {
  DEFAULT_NORMALIZE,
  dbToGain,
  formatGain,
  levelingParams,
  limiterParams,
  readReplayGain,
  replayGainToApply,
  sanitizeNormalize,
  type NormalizeSettings,
} from "./normalize";

export const normalizePrefs = createPrefs<NormalizeSettings>("settings", DEFAULT_NORMALIZE, sanitizeNormalize);

/** What was applied to the track that is playing now (for the panel). */
export const useNormalizeStatus = create<{ track: Track | null; gainDb: number | null }>(() => ({ track: null, gainDb: null }));

interface Live {
  ctx: AudioContext;
  trim: GainNode;
  comp: DynamicsCompressorNode;
  makeup: GainNode;
  limiter: DynamicsCompressorNode;
}
let live: Live | null = null;

function setComp(node: DynamicsCompressorNode, p: { threshold: number; knee: number; ratio: number; attack: number; release: number }, t: number) {
  node.threshold.setTargetAtTime(p.threshold, t, 0.05);
  node.knee.setTargetAtTime(p.knee, t, 0.05);
  node.ratio.setTargetAtTime(p.ratio, t, 0.05);
  node.attack.setTargetAtTime(p.attack, t, 0.05);
  node.release.setTargetAtTime(p.release, t, 0.05);
}

function currentGainDb(): number | null {
  const s = normalizePrefs.get();
  if (!s.replayGain) return null;
  const rg = readReplayGain(useNormalizeStatus.getState().track, s.mode);
  return rg ? replayGainToApply(rg, s.preGainDb) : null;
}

export function applyLive() {
  const gainDb = currentGainDb();
  useNormalizeStatus.setState({ gainDb });
  if (!live) return;
  const s = normalizePrefs.get();
  const t = live.ctx.currentTime;
  // Untagged tracks are left at their own level; tagged ones get tag + pre-gain.
  live.trim.gain.setTargetAtTime(dbToGain(gainDb ?? 0), t, 0.15);
  const lv = levelingParams(s.leveling);
  setComp(live.comp, lv, t);
  live.makeup.gain.setTargetAtTime(dbToGain(lv.makeupDb), t, 0.05);
  setComp(live.limiter, limiterParams(s.limiter), t);
}

normalizePrefs.use.subscribe(applyLive);

export const normalizeEffect: AudioEffect = {
  id: "cadence.normalize",
  label: "Volume normalization",
  // After the equalizer (10) and before the stereo effects (30).
  order: 20,
  create(ctx) {
    const trim = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    trim.connect(comp);
    comp.connect(makeup);
    makeup.connect(limiter);
    const mine: Live = { ctx, trim, comp, makeup, limiter };
    live = mine;
    applyLive();
    return {
      input: trim,
      output: limiter,
      dispose() {
        if (live === mine) live = null;
      },
    };
  },
};

export function NormalizePanel() {
  const s = normalizePrefs.use();
  const status = useNormalizeStatus();
  return (
    <div className="ax">
      <Section title="ReplayGain">
        <Row
          title="Use ReplayGain tags"
          description="When a track carries loudness tags, play it at a matching level so albums sound equally loud."
        >
          <Toggle on={s.replayGain} onChange={(replayGain) => normalizePrefs.set({ replayGain })} label="Use ReplayGain tags" />
        </Row>
        <Row title="Match by" description="Album keeps the loudness differences inside an album.">
          <Segmented
            label="ReplayGain mode"
            value={s.mode}
            options={[
              { value: "track", label: "Track" },
              { value: "album", label: "Album" },
            ]}
            onChange={(mode) => normalizePrefs.set({ mode })}
          />
        </Row>
        <Slider
          label="Pre-gain"
          value={s.preGainDb}
          min={-12}
          max={12}
          step={0.5}
          format={formatGain}
          disabled={!s.replayGain}
          onChange={(preGainDb) => normalizePrefs.set({ preGainDb })}
        />
        <p className="ax-hint" aria-live="polite">
          {!status.track
            ? "Play a song to see what is applied."
            : status.gainDb === null
              ? "This track has no ReplayGain tags, so only the leveling below is used."
              : `Applying ${formatGain(status.gainDb)} to this track.`}
        </p>
      </Section>

      <Section title="Leveling">
        <Slider
          label="Even out loud and quiet parts"
          value={s.leveling}
          min={0}
          max={1}
          step={0.05}
          format={(v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`)}
          onChange={(leveling) => normalizePrefs.set({ leveling })}
          hint="A gentle compressor. Keep it low for natural dynamics."
        />
        <Row title="Peak limiter" description="Stops loud peaks from clipping.">
          <Toggle on={s.limiter} onChange={(limiter) => normalizePrefs.set({ limiter })} label="Peak limiter" />
        </Row>
      </Section>

      <Note>
        Cadence&apos;s server does not read ReplayGain tags yet, so for now leveling does the work. Tags are used as soon as a
        track provides them. This affects music Cadence plays itself, not Spotify or Apple Music.
      </Note>
    </div>
  );
}

const normalizePlugin: Plugin = {
  manifest: {
    id: "cadence.normalize",
    name: "Volume Normalization",
    version: "1.0.0",
    description: "ReplayGain when available, otherwise a gentle compressor and limiter for even loudness.",
    author: "Cadence",
    capabilities: ["audio.dsp", "ui.settings", "storage", "player.read"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    normalizePrefs.bind(ctx.storage);
    ctx.registerAudioEffect(normalizeEffect);
    ctx.onNowPlaying((track) => {
      useNormalizeStatus.setState({ track });
      applyLive();
    });
    ctx.registerSettingsPanel({
      id: "normalize",
      title: "Volume Normalization",
      description: "Keep songs at a similar loudness.",
      keywords: ["replaygain", "loudness", "compressor", "limiter", "leveling", "volume"],
      render: () => <NormalizePanel />,
    });
  },
};

export default normalizePlugin;
