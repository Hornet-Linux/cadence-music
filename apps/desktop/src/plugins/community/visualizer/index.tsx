import { useEffect, useRef, useState } from "react";
import { Segmented } from "@/features/settings/controls";
import type { AudioEffect, Plugin, PluginContext } from "@/plugins/types";
import { createPrefs } from "../_audio-kit/prefs";
import { Note } from "../_audio-kit/ui";
import { FRAME_MS, SMOOTHING, bandLevels, peakOf, smoothLevels, waveformPoints, type Motion } from "./viz";
import "./style.css";

type Mode = "bars" | "wave";

export const vizPrefs = createPrefs<{ mode: Mode; motion: Motion }>(
  "settings",
  { mode: "bars", motion: prefersReducedMotion() ? "still" : "calm" },
  (v) => ({ mode: v.mode === "wave" ? "wave" : "bars", motion: v.motion === "still" ? "still" : "calm" }),
);

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

// The analyser is a pass-through node: audio goes in and comes out unchanged.
let analyser: AnalyserNode | null = null;
export const vizEffect: AudioEffect = {
  id: "cadence.visualizer",
  label: "Visualizer tap",
  order: 1000, // last, so it shows what you hear
  create(ctx) {
    const node = ctx.createAnalyser();
    node.fftSize = 2048;
    node.smoothingTimeConstant = 0.8;
    analyser = node;
    return {
      input: node,
      output: node,
      dispose() {
        if (analyser === node) analyser = null;
      },
    };
  },
};

let player: PluginContext["player"] | null = null;

const BARS = 32;

function cssColor(el: Element, name: string, fallback: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function VisualizerPage() {
  const prefs = vizPrefs.use();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    if (!el || !g) return;

    let levels: number[] = Array(BARS).fill(0);
    let wave: number[] = [];
    let raf = 0;
    let last = 0;
    let silentSince: number | null = null;
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = el.clientWidth;
      height = el.clientHeight;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(el);

    const draw = (time: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden || time - last < FRAME_MS[prefs.motion]) return;
      last = time;

      const playing = player?.getState().isPlaying ?? false;
      const smoothing = SMOOTHING[prefs.motion];
      if (analyser && playing) {
        const freq = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freq);
        levels = smoothLevels(levels, bandLevels(freq, analyser.context.sampleRate, BARS), smoothing.attack, smoothing.release);
        const td = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(td);
        wave = waveformPoints(td, 96);
      } else {
        // Nothing playing: let the picture settle gently.
        levels = smoothLevels(levels, Array(BARS).fill(0), 0.1, 0.12);
        wave = wave.map((v) => v * 0.85);
      }

      // A playing track that produces no signal at all is probably not routed through the audio engine.
      if (playing && analyser && peakOf(levels) < 0.005) {
        silentSince ??= time;
        if (time - silentSince > 4000) setHint("No signal. This track may not be playing through Cadence's audio engine.");
      } else {
        silentSince = null;
        setHint(playing && !analyser ? "Nothing to show yet. Waiting for audio from Cadence's own player." : null);
      }

      g.clearRect(0, 0, width, height);
      const ink = cssColor(el, "--text-muted", "#a3a3b2");
      const faint = cssColor(el, "--border-strong", "rgba(255,255,255,0.12)");
      g.fillStyle = ink;
      g.strokeStyle = ink;
      if (prefs.mode === "bars") {
        const gap = 4;
        const w = (width - gap * (BARS - 1)) / BARS;
        // A soft wash from the accent at the top into the muted ink: calm, no glow.
        const tint = g.createLinearGradient(0, 0, 0, height);
        tint.addColorStop(0, cssColor(el, "--accent", ink));
        tint.addColorStop(1, ink);
        g.fillStyle = tint;
        g.globalAlpha = 0.7;
        levels.forEach((v, i) => {
          const h = Math.max(2, v * (height - 8));
          const x = i * (w + gap);
          g.beginPath();
          g.roundRect?.(x, height - h, w, h, Math.min(4, w / 2));
          if (!g.roundRect) g.rect(x, height - h, w, h);
          g.fill();
        });
      } else {
        g.globalAlpha = 0.35;
        g.strokeStyle = faint;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, height / 2);
        g.lineTo(width, height / 2);
        g.stroke();
        g.globalAlpha = 0.85;
        g.strokeStyle = ink;
        g.lineWidth = 2;
        g.lineJoin = "round";
        g.beginPath();
        wave.forEach((v, i) => {
          const x = (i / Math.max(1, wave.length - 1)) * width;
          const y = height / 2 - v * (height / 2 - 6);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        g.stroke();
      }
      g.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [prefs.mode, prefs.motion]);

  return (
    <div className="view viz-page">
      <header className="view-header">
        <h1>Visualizer</h1>
        <p className="muted">A quiet look at the sound of what is playing.</p>
      </header>
      <div className="viz-stage">
        <canvas ref={canvas} className="viz-canvas" role="img" aria-label="Live audio visualization" />
        {hint && <p className="viz-hint" role="status">{hint}</p>}
      </div>
      <div className="viz-controls">
        <Segmented
          label="Visualization style"
          value={prefs.mode}
          options={[
            { value: "bars", label: "Spectrum" },
            { value: "wave", label: "Waveform" },
          ]}
          onChange={(mode) => vizPrefs.set({ mode })}
        />
        <Segmented
          label="Motion"
          value={prefs.motion}
          options={[
            { value: "calm", label: "Calm motion" },
            { value: "still", label: "Almost still" },
          ]}
          onChange={(motion) => vizPrefs.set({ motion })}
        />
      </div>
      <Note>
        Movement is smoothed so nothing flashes. &quot;Almost still&quot; redraws once a second, and is the default when your
        device asks for reduced motion. It shows music Cadence plays itself; Spotify and Apple Music play inside their own players,
        which a web page cannot analyse.
      </Note>
    </div>
  );
}

const GraphIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
    <path d="M5 18v-5M9 18V7M13 18v-8M17 18V4M21 18v-4" />
  </svg>
);

const visualizerPlugin: Plugin = {
  manifest: {
    id: "cadence.visualizer",
    name: "Visualizer",
    version: "1.0.0",
    description: "A calm spectrum or waveform view of the music, with reduced-motion support.",
    author: "Cadence",
    capabilities: ["audio.dsp", "ui.sidebar", "storage", "player.read"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    vizPrefs.bind(ctx.storage);
    player = ctx.player;
    ctx.registerAudioEffect(vizEffect);
    ctx.registerSidebarItem({ id: "visualizer", label: "Visualizer", icon: <GraphIcon />, render: () => <VisualizerPage /> });
  },
};

export default visualizerPlugin;
