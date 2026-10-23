import { usePlayer } from "@/player/playerStore";
import type { PlayerApi } from "../../types";
import type { RemoteCommand } from "./types";

const validCommand = (c: unknown): c is RemoteCommand => typeof c === "object" && c !== null && typeof (c as { type?: unknown }).type === "string";

/** Carry out a command that arrived from another player. Unknown or malformed commands are ignored. */
export async function executeCommand(player: PlayerApi, raw: unknown): Promise<void> {
  if (!validCommand(raw)) return;
  const state = player.getState();
  switch (raw.type) {
    case "play":
      if (!state.isPlaying) player.toggle();
      break;
    case "pause":
      if (state.isPlaying) player.toggle();
      break;
    case "toggle":
      player.toggle();
      break;
    case "next":
      await player.next();
      break;
    case "previous":
      await player.previous();
      break;
    case "seek":
      if (typeof raw.position === "number") player.seek(raw.position);
      break;
    case "volume":
      if (typeof raw.volume === "number") player.setVolume(raw.volume);
      break;
    case "queue.add":
      player.enqueue(raw.track);
      break;
    case "queue.jump":
      await usePlayer.getState().jumpTo(raw.index);
      break;
    case "queue.play": {
      if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) return;
      await player.playTracks(raw.tracks, raw.index);
      if (raw.position && raw.position > 0) player.seek(raw.position);
      if (raw.play === false && player.getState().isPlaying) player.toggle();
      break;
    }
  }
}
