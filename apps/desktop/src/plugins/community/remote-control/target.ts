import type { OutputTarget, PluginContext } from "../../types";
import { friendlyError } from "../_devices/errors";
import { useServer } from "../../builtins/server/serverStore";
import { selectOthers, sendRemoteCommand, useRemote } from "./remoteStore";
import type { RemoteDevice } from "./types";

export const REMOTE_TARGET_ID = "cadence.remote-control";

// Module level so the hand-off survives the host rebuilding plugins (which re-runs activate).
let controlled: string | null = null;

async function fetchDevices(): Promise<RemoteDevice[]> {
  const res = await useServer.getState().api<{ devices: RemoteDevice[] }>("api/remote-control/devices");
  useRemote.getState().setDevices(res.devices);
  return res.devices;
}

/** The part of the queue to send: at most 200 tracks around the current one. */
export function queueWindow(queue: unknown[], index: number, max = 200): { start: number; index: number } {
  const start = queue.length > max ? Math.max(0, Math.min(index - 20, queue.length - max)) : 0;
  return { start, index: index - start };
}

/**
 * "Other Cadence devices": hand playback to another of your players. It receives the queue and position and
 * plays; this device stops. Choosing "This device" again brings the queue back here.
 */
export function createRemoteTarget(ctx: PluginContext): OutputTarget {
  return {
    id: REMOTE_TARGET_ID,
    label: "Other Cadence devices",
    async listDevices() {
      try {
        const self = useRemote.getState().deviceId;
        const others = selectOthers(await fetchDevices(), self).filter((d) => d.online);
        return others.map((d) => ({ id: d.id, name: d.name }));
      } catch (err) {
        throw new Error(friendlyError(err, "Could not reach your server."));
      }
    },
    async select(deviceId) {
      if (deviceId === null) {
        const id = controlled;
        controlled = null;
        if (!id) return;
        // Bring the queue back: read where the other player got to, then stop it.
        const device = (await fetchDevices().catch(() => [] as RemoteDevice[])).find((d) => d.id === id);
        const state = device?.state;
        if (device?.online) await sendRemoteCommand(id, { type: "pause" }).catch(() => undefined);
        if (state && state.queue.length > 0) {
          await ctx.player.playTracks(state.queue, Math.max(0, state.index));
          if (state.position > 1) ctx.player.seek(state.position);
          if (!state.isPlaying && ctx.player.getState().isPlaying) ctx.player.toggle();
        }
        return;
      }
      const s = ctx.player.getState();
      if (!s.current) throw new Error("Start something playing first, then choose where it plays.");
      const win = queueWindow(s.queue, s.index);
      try {
        await sendRemoteCommand(deviceId, {
          type: "queue.play",
          tracks: s.queue.slice(win.start, win.start + 200),
          index: win.index,
          position: s.position,
          play: s.isPlaying,
        });
      } catch (err) {
        throw new Error(friendlyError(err, "That device is not reachable."));
      }
      controlled = deviceId;
      if (ctx.player.getState().isPlaying) ctx.player.toggle();
      useRemote.getState().select(deviceId);
    },
  };
}
