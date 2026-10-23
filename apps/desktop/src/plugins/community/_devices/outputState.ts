import { create } from "zustand";
import { usePlayer } from "@/player/playerStore";
import { usePluginHost } from "@/plugins/host";

/** Where playback is going right now, other than this device. */
export interface ActiveOutput {
  targetId: string;
  deviceId: string;
  deviceName: string;
}

interface OutputState {
  active: ActiveOutput | null;
  /** A short message when the last switch or the current output failed. */
  error: string | null;
  busy: boolean;
  setActive: (active: ActiveOutput | null) => void;
  setError: (error: string | null) => void;
}

export const useOutput = create<OutputState>((set) => ({
  active: null,
  error: null,
  busy: false,
  setActive: (active) => set({ active }),
  setError: (error) => set({ error }),
}));

/**
 * Send playback to a device, or back to this one (`deviceId` null). Whatever was playing elsewhere is released
 * first. The target does the work in its own `select`; this keeps the bookkeeping in one place.
 */
export async function chooseOutput(targetId: string | null, deviceId: string | null, deviceName = ""): Promise<void> {
  const { active, setActive, setError } = useOutput.getState();
  const targets = usePluginHost.getState().contributions.outputTargets;
  useOutput.setState({ busy: true, error: null });
  try {
    if (active && (targetId !== active.targetId || deviceId === null)) {
      const previous = targets.find((t) => t.id === active.targetId);
      setActive(null);
      await previous?.select(null);
    }
    if (targetId && deviceId) {
      const target = targets.find((t) => t.id === targetId);
      if (!target) throw new Error("That output is no longer available.");
      await target.select(deviceId);
      setActive({ targetId, deviceId, deviceName });
    }
  } catch (err) {
    setActive(null);
    setError(err instanceof Error ? err.message : "Could not switch the output.");
  } finally {
    useOutput.setState({ busy: false });
  }
}

/** A target calls this when its device stops working, so the picker stops claiming playback is there. */
export function reportOutputLost(targetId: string, message: string): void {
  const { active } = useOutput.getState();
  if (active?.targetId === targetId) useOutput.setState({ active: null });
  useOutput.setState({ error: message });
}

// ---- silencing this device while another one plays -------------------------------------------------

let weMuted = false;
let silenceUnsubscribe: (() => void) | null = null;

/**
 * Keep this device's own speakers quiet. The local player keeps running (silently) so the queue, the position
 * and the "ended -> next" logic keep working exactly as before; only the sound goes to the other device.
 */
export function silenceLocal(on: boolean): void {
  if (on) {
    if (!usePlayer.getState().muted) {
      weMuted = true;
      usePlayer.getState().toggleMute();
    }
    if (!silenceUnsubscribe) {
      // Changing the volume unmutes; mute again right after, once the player has finished its own update.
      silenceUnsubscribe = usePlayer.subscribe((s) => {
        if (!s.muted) queueMicrotask(() => !usePlayer.getState().muted && silenceUnsubscribe && usePlayer.getState().toggleMute());
      });
    }
    return;
  }
  silenceUnsubscribe?.();
  silenceUnsubscribe = null;
  if (weMuted && usePlayer.getState().muted) usePlayer.getState().toggleMute();
  weMuted = false;
}

export function isLocalSilenced(): boolean {
  return silenceUnsubscribe !== null;
}

/** Show or clear a warning without changing which output is selected (e.g. "this track cannot be played there"). */
export function setOutputWarning(message: string | null): void {
  useOutput.setState({ error: message });
}
