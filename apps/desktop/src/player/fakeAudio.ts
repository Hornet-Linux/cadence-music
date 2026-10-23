import { vi } from "vitest";

/** A recording stand-in for Web Audio nodes: remembers what was connected to what. */
export class FakeNode {
  edges: FakeNode[] = [];
  disconnected = 0;
  gain = { value: 1 };
  constructor(public label = "node") {}
  connect(target: FakeNode) {
    this.edges.push(target);
    return target;
  }
  disconnect() {
    this.edges = [];
    this.disconnected++;
  }
}

export interface FakeContextOptions {
  state?: "running" | "suspended";
  /** Whether resume() actually wakes the context. */
  resumable?: boolean;
  failCapture?: boolean;
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: "running" | "suspended" | "closed";
  destination = new FakeNode("destination");
  captured: HTMLMediaElement[] = [];
  gains: FakeNode[] = [];
  resume = vi.fn(async () => {
    if (this.opts.resumable !== false) this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor(public opts: FakeContextOptions = {}) {
    this.state = opts.state ?? "running";
    FakeAudioContext.instances.push(this);
  }
  createGain() {
    const g = new FakeNode("gain");
    this.gains.push(g);
    return g as unknown as GainNode;
  }
  createMediaElementSource(el: HTMLMediaElement) {
    if (this.opts.failCapture) throw new Error("already connected");
    this.captured.push(el);
    return new FakeNode("source") as unknown as MediaElementAudioSourceNode;
  }
}
