import type { Driver, DriverControls, DriverHooks } from "../_streaming/embedded";

/**
 * Drives SoundCloud's official HTML5 Widget (https://developers.soundcloud.com/docs/api/html5-widget).
 * The widget is SoundCloud's own player: it shows the uploader, artwork, SoundCloud branding and a
 * link back to the track, and enforces the uploader's usage restrictions. We only use its
 * documented methods and events.
 */

const SCRIPT_URL = "https://w.soundcloud.com/player/api.js";
const WIDGET_URL = "https://w.soundcloud.com/player/";

export interface SCWidget {
  bind(event: string, listener: (data?: { currentPosition?: number; relativePosition?: number }) => void): void;
  unbind(event: string): void;
  play(): void;
  pause(): void;
  seekTo(ms: number): void;
  setVolume(volume: number): void;
  getDuration(cb: (ms: number) => void): void;
  load(url: string, options?: Record<string, unknown>): void;
}

export interface SCNamespace {
  Widget: ((iframe: HTMLIFrameElement) => SCWidget) & {
    Events: { READY: string; PLAY: string; PAUSE: string; FINISH: string; PLAY_PROGRESS: string; SEEK: string; ERROR: string };
  };
}

declare global {
  interface Window {
    SC?: SCNamespace;
  }
}

let loading: Promise<SCNamespace> | null = null;

export function loadSoundCloudApi(): Promise<SCNamespace> {
  if (window.SC?.Widget) return Promise.resolve(window.SC);
  if (!loading) {
    loading = new Promise<SCNamespace>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => (window.SC?.Widget ? resolve(window.SC) : reject(new Error("The SoundCloud player is unavailable")));
      script.onerror = () => {
        loading = null;
        script.remove();
        reject(new Error("Couldn't load the SoundCloud player. Check your connection."));
      };
      document.head.append(script);
    });
  }
  return loading;
}

/** The widget's iframe address for a track. Defaults keep the uploader, artwork and branding visible. */
export function widgetSrc(trackId: string): string {
  const resource = `https://api.soundcloud.com/tracks/${encodeURIComponent(trackId)}`;
  const q = new URLSearchParams({
    url: resource,
    auto_play: "false",
    show_user: "true",
    show_artwork: "true",
    buying: "false",
    download: "false",
    sharing: "false",
  });
  return `${WIDGET_URL}?${q.toString()}`;
}

export interface SoundCloudDriverDeps {
  load?: () => Promise<SCNamespace>;
}

export function soundcloudDriver(trackId: string, deps: SoundCloudDriverDeps = {}): Driver {
  const load = deps.load ?? loadSoundCloudApi;
  return {
    async setup(body: HTMLElement, hooks: DriverHooks): Promise<DriverControls> {
      const SC = await load();
      const iframe = document.createElement("iframe");
      iframe.title = "SoundCloud player";
      iframe.className = "stream-dock-frame";
      iframe.setAttribute("allow", "autoplay");
      iframe.setAttribute("scrolling", "no");
      iframe.src = widgetSrc(trackId);
      body.append(iframe);
      const widget = SC.Widget(iframe);
      const E = SC.Widget.Events;

      return await new Promise<DriverControls>((resolve, reject) => {
        let destroyed = false;
        let duration = 0;
        const timer = setTimeout(() => reject(new Error("The SoundCloud player took too long to start.")), 20_000);

        const controls: DriverControls = {
          play: () => widget.play(),
          pause: () => widget.pause(),
          seek: (s) => widget.seekTo(Math.round(s * 1000)),
          setVolume: (v) => widget.setVolume(Math.round(Math.min(1, Math.max(0, v)) * 100)),
          destroy() {
            destroyed = true;
            clearTimeout(timer);
            for (const ev of Object.values(E)) {
              try {
                widget.unbind(ev);
              } catch {
                // Gone already.
              }
            }
            iframe.remove();
          },
        };

        widget.bind(E.READY, () => {
          clearTimeout(timer);
          widget.getDuration((ms) => {
            duration = ms > 0 ? ms / 1000 : 0;
            hooks.ready({ durationSec: duration || undefined });
            resolve(controls);
          });
        });
        widget.bind(E.PLAY, () => !destroyed && hooks.state("playing"));
        widget.bind(E.PAUSE, () => !destroyed && hooks.state("paused"));
        widget.bind(E.FINISH, () => !destroyed && hooks.state("ended"));
        widget.bind(E.PLAY_PROGRESS, (d) => {
          if (!destroyed && typeof d?.currentPosition === "number") hooks.progress(d.currentPosition / 1000, duration || undefined);
        });
        widget.bind(E.SEEK, (d) => {
          if (!destroyed && typeof d?.currentPosition === "number") hooks.progress(d.currentPosition / 1000, duration || undefined);
        });
        widget.bind(E.ERROR, () => {
          const message = "SoundCloud couldn't play this track here. Use Open in SoundCloud.";
          if (!destroyed) hooks.failed(message, false);
          reject(new Error(message));
        });
      });
    },
  };
}
