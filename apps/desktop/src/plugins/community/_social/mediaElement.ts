/**
 * The host plays server and local files through one shared <audio> element that no plugin is
 * handed. Plugins that need its playback rate (practice mode, listen-along drift correction) learn
 * which element is in use by watching play(), pause() and seeks, so no host file has to change.
 * Services with their own player (Spotify, Apple Music) never use it; for them this returns null.
 */

let current: HTMLMediaElement | null = null;
let uninstall: (() => void) | null = null;
let users = 0;

/** Start watching for the player's audio element. Returns a function that stops (reference counted). */
export function watchMediaElement(): () => void {
  users += 1;
  if (!uninstall && typeof HTMLMediaElement !== "undefined") {
    const proto = HTMLMediaElement.prototype;
    const originalPlay = proto.play;
    const originalPause = proto.pause;
    const timeDescriptor = Object.getOwnPropertyDescriptor(proto, "currentTime");
    const remember = (el: HTMLMediaElement) => {
      if (el instanceof HTMLAudioElement) current = el;
    };
    const play = function (this: HTMLMediaElement) {
      remember(this);
      return originalPlay.apply(this);
    };
    const pause = function (this: HTMLMediaElement) {
      remember(this);
      return originalPause.apply(this);
    };
    proto.play = play;
    proto.pause = pause;
    if (timeDescriptor?.set && timeDescriptor.configurable) {
      const set = timeDescriptor.set;
      Object.defineProperty(proto, "currentTime", {
        ...timeDescriptor,
        set(this: HTMLMediaElement, value: number) {
          remember(this);
          set.call(this, value);
        },
      });
    }
    uninstall = () => {
      if (proto.play === play) proto.play = originalPlay;
      if (proto.pause === pause) proto.pause = originalPause;
      if (timeDescriptor?.set && timeDescriptor.configurable) Object.defineProperty(proto, "currentTime", timeDescriptor);
      current = null;
    };
  }
  return () => {
    users = Math.max(0, users - 1);
    if (users === 0) {
      uninstall?.();
      uninstall = null;
    }
  };
}

/** The element the player is using, once it has played or sought; otherwise null. */
export function getMediaElement(): HTMLMediaElement | null {
  return current;
}

/** Set the playback speed (keeping pitch). Returns false when the playing track is not plain media. */
export function setPlaybackRate(rate: number): boolean {
  const el = getMediaElement();
  if (!el) return false;
  const clamped = Math.min(2, Math.max(0.25, rate));
  el.defaultPlaybackRate = clamped;
  el.playbackRate = clamped;
  el.preservesPitch = true;
  return true;
}