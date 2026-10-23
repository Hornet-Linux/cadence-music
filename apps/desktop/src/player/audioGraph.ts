import type { AudioEffect } from "@/plugins/types";

/**
 * The Web Audio graph that audio effects (granted by the "audio.dsp" capability) plug into.
 *
 *   <audio> -> MediaElementSource -> bus -> effect 1 -> effect 2 -> ... -> speakers
 *
 * Design rules, all about never breaking playback:
 *
 *  - Lazy. Nothing is created until at least one effect is registered AND a track is about
 *    to play. With no effects the <audio> element plays exactly as it always did.
 *  - Capturing an element is permanent (a browser limitation) and a captured element is
 *    silent if its audio context is not running. So we only capture after the context is
 *    confirmed running; otherwise the element simply plays plain, unprocessed.
 *  - A cross-origin media file without CORS headers would be captured as silence. The
 *    player therefore asks `canRouteUrl()` first and plays such URLs through an element
 *    that is never captured (see deck.ts).
 *  - If AudioContext is missing, throws, or is blocked, `attach()` returns false and the
 *    caller plays the plain element.
 *  - One misbehaving effect is skipped; it cannot take the chain or the music down.
 *
 * Limits: only plain media played by the <audio> element is processed. Sources with their
 * own player (Spotify and Apple Music SDKs, `ExternalPlayback`) decode and output audio
 * inside the vendor's code, which the browser does not let a page tap, so effects,
 * crossfade, speed and the visualizer cannot touch them.
 */

export type GraphStatus = "idle" | "running" | "suspended" | "unavailable";

type ContextFactory = () => AudioContext | null;

const defaultFactory: ContextFactory = () => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ latencyHint: "playback" });
  } catch {
    return null;
  }
};

interface BuiltEffect {
  effect: AudioEffect;
  input: AudioNode;
  output: AudioNode;
  dispose?: () => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sameEffects(a: AudioEffect[], b: AudioEffect[]) {
  return a.length === b.length && a.every((effect, i) => effect === b[i]);
}

export class AudioGraph {
  private ctx: AudioContext | null = null;
  private unavailable = false;
  private effects: AudioEffect[] = [];
  private bus: GainNode | null = null;
  private built: BuiltEffect[] = [];
  private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private captured = 0;
  private wantedListeners = new Set<(wanted: boolean) => void>();
  private gesturesWatched = false;

  constructor(private readonly createContext: ContextFactory = defaultFactory) {}

  /** True when there are effects to apply and Web Audio looks usable. */
  get wanted(): boolean {
    return this.effects.length > 0 && !this.unavailable;
  }

  get status(): GraphStatus {
    if (this.unavailable) return "unavailable";
    if (!this.ctx) return "idle";
    return this.ctx.state === "running" ? "running" : "suspended";
  }

  /** The audio context once one exists. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  isCaptured(el: HTMLMediaElement): boolean {
    return this.sources.has(el);
  }

  /** Called with the new value whenever `wanted` flips. */
  onWantedChange(listener: (wanted: boolean) => void): () => void {
    this.wantedListeners.add(listener);
    return () => this.wantedListeners.delete(listener);
  }

  /** Replace the effect list (from the plugin host). Rebuilds the chain only if it changed. */
  setEffects(next: AudioEffect[]): void {
    if (sameEffects(this.effects, next)) return;
    const wasWanted = this.wanted;
    this.effects = [...next];
    if (this.ctx) this.rebuild();
    if (wasWanted !== this.wanted) for (const l of this.wantedListeners) l(this.wanted);
  }

  /**
   * Route `el` through the effects. Resolves true when the element is now processed, false
   * when it must play plain (no effects, no Web Audio, or the context is blocked).
   */
  async attach(el: HTMLMediaElement): Promise<boolean> {
    if (this.sources.has(el)) return true;
    if (!this.wanted) return false;
    const ctx = this.ensureContext();
    if (!ctx) return false;
    const running = () => ctx.state === "running";
    if (!running()) {
      try {
        await Promise.race([ctx.resume(), wait(400)]);
      } catch {
        // Autoplay policy: stays suspended until a gesture.
      }
      // A captured element is silent while the context is suspended, so stay plain.
      if (!running()) return false;
    }
    try {
      this.ensureBus(ctx);
      const source = ctx.createMediaElementSource(el);
      source.connect(this.bus!);
      this.sources.set(el, source);
      this.captured++;
      return true;
    } catch {
      // Already owned by another context, or the browser refused.
      return false;
    }
  }

  /** Wake a suspended context. Safe to call at any time; call it from user gestures. */
  async resume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
    try {
      await ctx.resume();
    } catch {
      // Still blocked; try again on the next gesture.
    }
  }

  /** Resume the context on the first touch, click or key (autoplay policies need one). */
  watchGestures(target: Pick<Window, "addEventListener"> = window): void {
    if (this.gesturesWatched) return;
    this.gesturesWatched = true;
    const wake = () => {
      if (this.captured > 0) void this.resume();
    };
    for (const type of ["pointerdown", "touchend", "keydown"]) {
      target.addEventListener(type, wake, { passive: true, capture: true });
    }
  }

  /** Tear everything down (tests). Captured elements stay captured, as browsers require. */
  dispose(): void {
    this.disposeChain();
    try {
      this.bus?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.bus = null;
    void Promise.resolve(this.ctx?.close()).catch(() => undefined);
    this.ctx = null;
    this.effects = [];
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const ctx = this.createContext();
    if (!ctx) {
      this.unavailable = true;
      for (const l of this.wantedListeners) l(false);
      return null;
    }
    this.ctx = ctx;
    return ctx;
  }

  private ensureBus(ctx: AudioContext) {
    if (this.bus) return;
    this.bus = ctx.createGain();
    this.rebuild();
  }

  private disposeChain() {
    for (const item of this.built) {
      try {
        item.dispose?.();
      } catch {
        // Ignore a failing cleanup.
      }
      for (const node of [item.input, item.output]) {
        try {
          node.disconnect();
        } catch {
          // Not connected.
        }
      }
    }
    this.built = [];
  }

  /** (Re)connect bus -> effects -> destination. */
  private rebuild() {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    this.disposeChain();
    try {
      bus.disconnect();
    } catch {
      // Not connected yet.
    }
    let tail: AudioNode = bus;
    for (const effect of this.effects) {
      try {
        const nodes = effect.create(ctx);
        tail.connect(nodes.input);
        tail = nodes.output;
        this.built.push({ effect, ...nodes });
      } catch {
        // Skip this effect; keep the rest of the chain.
      }
    }
    try {
      tail.connect(ctx.destination);
    } catch {
      // Last resort: bypass every effect so the music keeps playing.
      this.disposeChain();
      try {
        bus.disconnect();
      } catch {
        // Nothing to do.
      }
      bus.connect(ctx.destination);
    }
  }
}

/** The one graph the player uses. */
export const audioGraph = new AudioGraph();

// ---- CORS check -------------------------------------------------------------

const verdicts = new Map<string, { ok: boolean; until: number }>();
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

/** Forget cached CORS verdicts (tests). */
export function resetRouteCache() {
  verdicts.clear();
}

/**
 * Whether a media URL can go through Web Audio. A cross-origin file is captured as silence
 * unless the server sends CORS headers, so same-origin and blob/data URLs pass at once and
 * other http(s) URLs are probed with a 1-byte ranged request (cached per origin).
 * Anything doubtful returns false: the element then plays plain, unprocessed.
 */
export async function canRouteUrl(
  url: string,
  options: { fetchFn?: typeof fetch; timeoutMs?: number; base?: string } = {},
): Promise<boolean> {
  const base = options.base ?? (typeof location !== "undefined" ? location.href : "http://localhost/");
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return false;
  }
  if (u.protocol === "blob:" || u.protocol === "data:") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.origin === new URL(base).origin) return true;

  const cached = verdicts.get(u.origin);
  if (cached && (cached.ok || cached.until > Date.now())) return cached.ok;

  const fetchFn = options.fetchFn ?? (typeof fetch === "function" ? fetch : undefined);
  if (!fetchFn) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  try {
    // A successful CORS fetch means the media element in "anonymous" mode will load too.
    await fetchFn(u.href, {
      mode: "cors",
      credentials: "omit",
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
    });
    verdicts.set(u.origin, { ok: true, until: Infinity });
    return true;
  } catch {
    // Either a real CORS block or a network hiccup. Do not cache timeouts for long.
    if (!controller.signal.aborted) verdicts.set(u.origin, { ok: false, until: Date.now() + NEGATIVE_TTL_MS });
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
