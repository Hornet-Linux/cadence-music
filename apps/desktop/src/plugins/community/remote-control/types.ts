import type { Track } from "@/shared/types";

/** What another player reports about itself (mirrors the server relay). */
export interface RemoteState {
  track: Track | null;
  isPlaying: boolean;
  position: number;
  duration: number;
  volume: number;
  queue: Track[];
  index: number;
  updatedAt: number;
}

export interface RemoteDevice {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  lastSeen: number;
  state: RemoteState | null;
}

export type RemoteCommand =
  | { type: "play" | "pause" | "toggle" | "next" | "previous" }
  | { type: "seek"; position: number }
  | { type: "volume"; volume: number }
  | { type: "queue.play"; tracks: Track[]; index: number; position?: number; play?: boolean }
  | { type: "queue.add"; track: Track }
  | { type: "queue.jump"; index: number };

export interface SseMessage {
  event: string;
  data: unknown;
}
