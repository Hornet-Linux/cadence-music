import { create } from "zustand";

/** A calm reason why the server refused to start a stream (for example a device or daily limit), shown by the player bar. */
export function friendlyBlock(code: string | undefined, serverMessage: string): string | null {
  if (code === "quota_concurrent_streams") return "Playing on another device. Stop it there to play here.";
  if (code?.startsWith("quota_")) return serverMessage || "Your listening limit has been reached for now.";
  return null;
}

export const usePlaybackBlock = create<{ message: string | null; set: (message: string | null) => void }>((set) => ({
  message: null,
  set: (message) => set({ message }),
}));
