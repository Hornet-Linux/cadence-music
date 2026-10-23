import type { CommandContribution, PlayerApi } from "../../types";
import type { TransportAction } from "../_desktop/transport";

export interface RouterDeps {
  /** Built-in playback commands (play, next, volume...). */
  actions: Record<string, TransportAction>;
  /** Commands other plugins registered with the host. */
  registry: () => CommandContribution[];
  /** Whether other plugins' commands may be run by remotes. Off unless the person allows it. */
  allowOthers: () => boolean;
}

export interface CommandRouter {
  names: () => string[];
  run: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Finds and runs the command a remote asked for. Built-in playback commands always work;
 * commands from other plugins are reachable by their full id only when the person allows it.
 */
export function createRouter(deps: RouterDeps): CommandRouter {
  const own = (c: CommandContribution) => c.id.startsWith("cadence.media-keys.");
  return {
    names() {
      const names = new Set(Object.keys(deps.actions));
      if (deps.allowOthers()) for (const c of deps.registry()) if (!own(c)) names.add(c.id);
      return [...names].sort();
    },
    async run(name, args) {
      const action = Object.prototype.hasOwnProperty.call(deps.actions, name) ? deps.actions[name] : undefined;
      if (action) return (await action.run(args)) ?? null;
      if (deps.allowOthers()) {
        const command = deps.registry().find((c) => c.id === name);
        if (command) {
          await command.run();
          return null;
        }
      }
      throw new Error("unknown_command");
    },
  };
}

type PlayerState = ReturnType<PlayerApi["getState"]>;

export interface ApiState {
  playing: boolean;
  track: { id: string; title: string; artists: string[]; album: string | null; artwork: string | null; source: string | null } | null;
  positionSec: number;
  durationSec: number;
  /** 0 to 1. */
  volume: number;
  liked: boolean;
  queueLength: number;
}

/** The now-playing snapshot remotes see. Position is rounded so it only changes about once a second. */
export function buildState(s: PlayerState, liked: boolean): ApiState {
  const t = s.current;
  return {
    playing: s.isPlaying,
    track: t
      ? {
          id: t.id,
          title: t.title,
          artists: t.artists.map((a) => a.name),
          album: t.album ?? null,
          artwork: t.artwork ?? null,
          source: t.source ?? null,
        }
      : null,
    positionSec: Math.round(s.position),
    durationSec: Math.round(s.duration),
    volume: Math.round(s.volume * 100) / 100,
    liked,
    queueLength: s.queue.length,
  };
}