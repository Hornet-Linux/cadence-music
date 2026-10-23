import { SERVER_TRACK_PREFIX, useServer } from "@/plugins/builtins/server/serverStore";
import type { Plugin } from "../../types";
import { lrcToLyrics } from "../lyrics-view/lrc";

interface LocalLyricsResponse {
  lrc?: string;
  plain?: string;
  from: "lrc-file" | "txt-file" | "embedded";
}

const SOURCE: Record<LocalLyricsResponse["from"], string> = {
  "lrc-file": "a .lrc file in your library",
  "txt-file": "a .txt file in your library",
  embedded: "the song file tags",
};

/** Lyrics saved next to your server tracks (.lrc / .txt) or inside the files tags. */
const plugin: Plugin = {
  manifest: {
    id: "cadence.lyrics-local",
    name: "Lyrics from your library",
    version: "1.0.0",
    description:
      "Shows lyrics stored with your server music: a .lrc or .txt file beside the song, or lyrics saved in its tags. Needs the Lyrics from the music library plugin turned on in the server (Settings, Plugins).",
    author: "Cadence",
    capabilities: ["provider.lyrics", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerLyricsProvider({
      id: "library-files",
      label: "Your library",
      async getLyrics(track) {
        if (!track.id.startsWith(SERVER_TRACK_PREFIX)) return null;
        const server = useServer.getState();
        if (!server.user) return null;
        try {
          const found = await server.api<LocalLyricsResponse>(`api/lyrics/local/${encodeURIComponent(track.id.slice(SERVER_TRACK_PREFIX.length))}`);
          return lrcToLyrics(found.lrc ?? found.plain ?? "", SOURCE[found.from] ?? "your library");
        } catch (err) {
          // 404: no lyrics saved with this song, or the server plugin is off. Neither is an error.
          if ((err as { status?: number }).status === 404) return null;
          throw err;
        }
      },
    });
  },
};

export default plugin;
