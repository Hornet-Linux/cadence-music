import { audioGraph, canRouteUrl, type AudioGraph } from "./audioGraph";

/**
 * A small pool of <audio> elements. The player plays one at a time; a second one holds the
 * next track (pre-buffered for gapless) or blends in during a crossfade.
 *
 * Why a pool instead of one element: Web Audio can capture an element for effects only once
 * and only if its media is CORS-clean. A captured element is silent for non-CORS media, so
 * those URLs are played through an element that was never captured.
 */
export interface DeckDeps {
  graph?: AudioGraph;
  canRoute?: (url: string) => Promise<boolean>;
  createElement?: () => HTMLAudioElement;
}

export class Deck {
  private readonly pool: HTMLAudioElement[] = [];
  private readonly graph: AudioGraph;
  private readonly canRoute: (url: string) => Promise<boolean>;
  private readonly createElement: () => HTMLAudioElement;
  private readonly inUse = new Set<HTMLAudioElement>();
  private readonly created: Array<(el: HTMLAudioElement) => void> = [];

  constructor(deps: DeckDeps = {}) {
    this.graph = deps.graph ?? audioGraph;
    this.canRoute = deps.canRoute ?? ((url) => canRouteUrl(url));
    this.createElement = deps.createElement ?? (() => new Audio());
  }

  /** Run `setup` for every element, including ones made later (to attach listeners). */
  onCreate(setup: (el: HTMLAudioElement) => void) {
    this.created.push(setup);
    for (const el of this.pool) setup(el);
  }

  /** Make a fresh element that nothing owns yet. */
  private make(): HTMLAudioElement {
    const el = this.createElement();
    el.preload = "auto";
    this.pool.push(el);
    for (const setup of this.created) setup(el);
    return el;
  }

  get size() {
    return this.pool.length;
  }

  isRouted(el: HTMLAudioElement) {
    return this.graph.isCaptured(el);
  }

  /** An element for the first track, before anything needs routing. */
  first(): HTMLAudioElement {
    const el = this.pool[0] ?? this.make();
    this.inUse.add(el);
    return el;
  }

  /**
   * Pick an element for `url`, send it through the effects when that is wanted and safe,
   * and point it at the URL. The caller starts it with play().
   */
  async prepare(url: string): Promise<HTMLAudioElement> {
    let routed = false;
    if (this.graph.wanted) routed = await this.canRoute(url);

    const idle = this.pool.filter((el) => !this.inUse.has(el));
    let el: HTMLAudioElement | undefined;
    if (routed) {
      el = idle.find((e) => this.graph.isCaptured(e)) ?? idle[0] ?? this.make();
      this.inUse.add(el); // claim before awaiting so a concurrent prepare() cannot take it
      // A false here means Web Audio is blocked: fall through to plain playback.
      if (!(await this.graph.attach(el))) {
        routed = false;
        this.inUse.delete(el);
      }
    }
    if (!routed) {
      // Never reuse a captured element for a URL that cannot go through the graph.
      const plain = this.pool.filter((e) => !this.inUse.has(e) && !this.graph.isCaptured(e));
      el = plain[0] ?? this.make();
      this.inUse.add(el);
    }
    const chosen = el!;
    // Must be set before src. "anonymous" is what lets Web Audio read cross-origin media.
    chosen.crossOrigin = routed ? "anonymous" : null;
    chosen.src = url;
    return chosen;
  }

  /** Return an element to the pool (stops it and drops its media). */
  release(el: HTMLAudioElement) {
    try {
      el.pause();
    } catch {
      // Detached element; nothing to stop.
    }
    el.removeAttribute("src");
    this.inUse.delete(el);
  }
}
