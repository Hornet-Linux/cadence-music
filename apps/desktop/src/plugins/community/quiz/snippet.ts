import { usePluginHost } from "@/plugins/host";
import type { Track } from "@/shared/types";

export type SnippetState = "idle" | "loading" | "playing" | "failed";

/**
 * Plays a short piece of a song on its own audio element, so the main player's queue is left
 * alone. Only songs that resolve to a plain media address work; songs on a service with its own
 * player (Spotify, Apple Music) resolve to a player handle, which is released and reported as failed.
 */
export class SnippetPlayer {
  private readonly audio = new Audio();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  state: SnippetState = "idle";

  constructor(private readonly onState: (state: SnippetState) => void) {
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => this.set("idle"));
  }

  private set(state: SnippetState) {
    this.state = state;
    this.onState(state);
  }

  async play(track: Track, startSec: number, lengthSec: number): Promise<boolean> {
    const seq = ++this.seq;
    this.stop(false);
    this.set("loading");
    try {
      const resolved = await usePluginHost.getState().resolveAudio(track);
      if (seq !== this.seq) {
        if (resolved && typeof resolved !== "string") void resolved.stop().catch(() => undefined);
        return true;
      }
      if (!resolved) {
        this.set("failed");
        return false;
      }
      if (typeof resolved !== "string") {
        void resolved.stop().catch(() => undefined);
        this.set("failed");
        return false;
      }
      this.audio.src = resolved;
      await new Promise<void>((ok, fail) => {
        const done = () => {
          cleanup();
          ok();
        };
        const bad = () => {
          cleanup();
          fail(new Error("load failed"));
        };
        const cleanup = () => {
          this.audio.removeEventListener("loadedmetadata", done);
          this.audio.removeEventListener("error", bad);
        };
        this.audio.addEventListener("loadedmetadata", done);
        this.audio.addEventListener("error", bad);
        this.audio.load();
      });
      if (seq !== this.seq) return true;
      this.audio.currentTime = Math.max(0, startSec);
      await this.audio.play();
      if (seq !== this.seq) return true;
      this.set("playing");
      this.timer = setTimeout(() => this.stop(true), lengthSec * 1000);
      return true;
    } catch {
      if (seq === this.seq) this.set("failed");
      return false;
    }
  }

  stop(report = true) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.audio.pause();
    if (report && this.state !== "failed") this.set("idle");
  }

  dispose() {
    this.seq += 1;
    this.stop(false);
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}