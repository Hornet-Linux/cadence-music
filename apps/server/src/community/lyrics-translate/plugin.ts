import type { ServerPlugin } from "../../plugins/types.js";
import { createProvider, type FetchFn, type LlmProvider } from "../../llm/core/index.js";
import { deviceMessage, publicMessage } from "../../llm/plugin.js";
import { ProviderStore } from "../../llm/store.js";
import { buildTranslateMessages, cleanTranslations, MAX_LINE_CHARS, MAX_LINES, TRANSLATE_SCHEMA, validLanguage } from "./prompt.js";

/** Translations per person: a song is a handful of requests, so this is generous but bounded. */
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 40;

export interface LyricsTranslateOptions {
  /** Lets tests stand in for the network when the server calls a provider. */
  fetchFn?: FetchFn;
}

/**
 * Translates lyric lines with a model the server owner set up (Settings, AI providers).
 * The lyrics view calls this when the listener picked a server provider.
 */
export function createLyricsTranslatePlugin(options: LyricsTranslateOptions = {}): ServerPlugin {
  return {
    id: "cadence.lyrics-translate",
    name: "Lyrics translation",
    version: "1.0.0",
    register(app, ctx) {
      const store = new ProviderStore(ctx.db, ctx.secret);
      const recent = new Map<number, number[]>();
      const busy = new Set<number>();

      function pick(ref: unknown): LlmProvider | null {
        let id: string | undefined;
        if (typeof ref === "string") {
          const [scope, rest] = ref.split(":");
          if (scope !== "server" || !rest) return null;
          id = rest;
        } else {
          const all = store.list().filter((p) => p.enabled);
          id = (all.find((p) => p.isDefault) ?? all[0])?.id;
        }
        const config = id ? store.config(id) : null;
        return config ? createProvider(config, options.fetchFn) : null;
      }

      app.post<{ Body: { provider?: string; lines?: unknown; target?: unknown } }>(
        "/api/lyrics/translate",
        { preHandler: ctx.requireUser },
        async (req, reply) => {
          const userId = req.user!.id;
          const body = req.body ?? {};
          if (!Array.isArray(body.lines) || !body.lines.every((l) => typeof l === "string") || body.lines.length === 0) {
            return reply.code(400).send({ error: "invalid_lines" });
          }
          if (body.lines.length > MAX_LINES) return reply.code(400).send({ error: "too_many_lines" });
          if (!validLanguage(body.target)) return reply.code(400).send({ error: "invalid_language" });
          const lines = (body.lines as string[]).map((l) => l.slice(0, MAX_LINE_CHARS));
          const target = body.target.trim();

          const provider = pick(body.provider);
          if (!provider) {
            return reply.code(409).send({ error: "no_provider", message: "No AI provider is set up on this server" });
          }

          const now = Date.now();
          const times = (recent.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
          if (times.length >= RATE_MAX) return reply.code(429).send({ error: "rate_limited" });
          if (busy.has(userId)) return reply.code(429).send({ error: "busy" });
          recent.set(userId, [...times, now]);

          busy.add(userId);
          try {
            const answer = await provider.chatJson({
              messages: buildTranslateMessages(lines, target),
              schema: TRANSLATE_SCHEMA as unknown as Record<string, unknown>,
              temperature: 0.2,
            });
            const translations = cleanTranslations(answer, lines.length);
            if (!translations) {
              return reply.code(502).send({ error: "bad_reply", message: "The model did not return one translation per line." });
            }
            return { translations };
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            req.log.warn({ detail: detail.slice(0, 500) }, "lyrics translation failed");
            const message = req.user?.is_admin === 1 ? deviceMessage(detail) : publicMessage(e);
            return reply.code(502).send({ error: "llm_failed", message });
          } finally {
            busy.delete(userId);
          }
        },
      );
    },
  };
}

export default createLyricsTranslatePlugin();
