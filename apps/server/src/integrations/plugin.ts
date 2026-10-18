import type { AppleMusicTokenResponse, IntegrationsResponse } from "@uma/shared";
import type { ServerPlugin } from "../plugins/types.js";
import { loadAppleMusicKey, mintAppleMusicToken } from "./appleMusicToken.js";

/** Refresh the cached developer token once less than this much life is left. */
const REFRESH_MARGIN_SEC = 60 * 60;

/**
 * Shares streaming-service settings with signed-in apps: the Spotify app ID,
 * and Apple Music developer tokens minted from a key that never leaves the
 * server.
 */
export const integrationsPlugin: ServerPlugin = {
  id: "core.integrations",
  name: "Streaming integrations",
  version: "1.0.0",
  register(app, ctx) {
    const { config, settings, requireUser } = ctx;
    // Fail at start-up, not on first use, if the key is unusable.
    const appleKey = config.appleMusic ? loadAppleMusicKey(config.appleMusic) : null;
    let cached: AppleMusicTokenResponse | null = null;

    app.get("/api/integrations", { preHandler: requireUser }, async (req): Promise<IntegrationsResponse> => {
      // The server owner's app ID wins; otherwise the one this person saved
      // from any of their devices.
      const clientId = config.spotifyClientId ?? settings.userSpotifyClientId(req.user!.id);
      return {
        spotify: clientId ? { clientId, source: config.spotifyClientId ? "server" : "account" } : null,
        appleMusic: { available: appleKey !== null },
      };
    });

    // Save (or clear, with null) this person's Spotify app ID for their other devices.
    app.put<{ Body: { clientId?: string | null } }>(
      "/api/me/integrations/spotify",
      { preHandler: requireUser },
      async (req, reply) => {
        const clientId = req.body?.clientId?.trim() || null;
        if (clientId && !/^[0-9a-f]{32}$/i.test(clientId)) {
          return reply.code(400).send({ error: "invalid_client_id" });
        }
        settings.setUserSpotifyClientId(req.user!.id, clientId);
        return reply.code(204).send();
      },
    );

    app.get("/api/integrations/apple-music/token", { preHandler: requireUser }, async (_req, reply) => {
      if (!config.appleMusic || !appleKey) {
        return reply.code(404).send({ error: "apple_music_not_configured" });
      }
      const now = Math.floor(Date.now() / 1000);
      if (!cached || cached.expiresAt - now < REFRESH_MARGIN_SEC) {
        cached = mintAppleMusicToken(config.appleMusic, appleKey, now);
      }
      return cached;
    });
  },
};
