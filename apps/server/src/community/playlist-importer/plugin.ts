import type { FastifyInstance } from "fastify";
import type { Db } from "../../db.js";
import type { ServerPlugin, ServerPluginContext } from "../../plugins/types.js";
import { CandidateIndex, THRESHOLDS, type Candidate, type Ranked, type Wanted } from "./matcher.js";
import { parseImport, type ImportFormat } from "./parsers.js";

export const PLUGIN_ID = "cadence.playlist-importer";
const MAX_MATCH_ITEMS = 500;
const MAX_EXTRA = 20_000;
const MAX_PARSE_BYTES = 8 * 1024 * 1024;
const FORMATS: ImportFormat[] = ["m3u", "xspf", "csv", "json", "itunes-xml"];

interface LibraryCandidate extends Candidate {
  kind: "server";
  albumArtist?: string;
}

interface ExtraCandidate extends Candidate {
  kind: "extra";
}

interface TrackRow {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  duration_sec: number | null;
}

/** The server library as match candidates; rebuilt only when tracks were added, removed or changed. */
class LibraryIndex {
  private signature = "";
  private index: CandidateIndex<LibraryCandidate> | null = null;

  constructor(private readonly db: Db) {}

  get(): CandidateIndex<LibraryCandidate> {
    const row = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(added_at), 0) AS a, COALESCE(MAX(mtime_ms), 0) AS m FROM tracks").get() as {
      n: number;
      a: number;
      m: number;
    };
    const signature = `${row.n}:${row.a}:${row.m}`;
    if (!this.index || signature !== this.signature) {
      const rows = this.db.prepare("SELECT id, title, artist, album, album_artist, duration_sec FROM tracks").all() as unknown as TrackRow[];
      this.index = new CandidateIndex(
        rows.map<LibraryCandidate>((r) => ({
          kind: "server",
          id: r.id,
          title: r.title,
          artists: [r.artist, r.album_artist].filter((a): a is string => !!a),
          album: r.album ?? undefined,
          durationSec: r.duration_sec ?? undefined,
        })),
      );
      this.signature = signature;
    }
    return this.index;
  }
}

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

function cleanWanted(input: unknown): Wanted | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const title = str(o.title);
  if (!title) return null;
  const artists = Array.isArray(o.artists) ? o.artists.map((a) => str(a)).filter(Boolean).slice(0, 10) : [];
  const durationSec = typeof o.durationSec === "number" && o.durationSec > 0 && o.durationSec < 36_000 ? o.durationSec : undefined;
  return { title, artists, album: str(o.album) || undefined, durationSec };
}

function cleanExtra(input: unknown): ExtraCandidate | null {
  const w = cleanWanted(input);
  const id = input && typeof input === "object" ? str((input as { id?: unknown }).id, 500) : "";
  return w && id ? { kind: "extra", id, ...w } : null;
}

export const playlistImporterPlugin: ServerPlugin = {
  id: PLUGIN_ID,
  name: "Playlist importer",
  version: "1.0.0",
  description:
    "Reads M3U, XSPF, CSV, JSON and Apple Music / iTunes library files and matches the tracks to your server library with a scored, explainable matcher. The app shows the preview and creates the playlist.",
  configFields: [],
  adminRoutes: [],
  userRoutes: ["POST /api/import/parse", "POST /api/import/match"],
  register(app, ctx) {
    registerImporter(app, ctx);
  },
};

function registerImporter(app: FastifyInstance, ctx: ServerPluginContext): void {
  const { requireUser } = ctx;
  const library = new LibraryIndex(ctx.db);

  app.post<{ Body: { text?: unknown; format?: unknown; filename?: unknown; playlist?: unknown } }>(
    "/api/import/parse",
    { preHandler: requireUser, bodyLimit: MAX_PARSE_BYTES },
    async (req, reply) => {
      const text = req.body?.text;
      if (typeof text !== "string" || text.length === 0) return reply.code(400).send({ error: "invalid_request", message: "Send the file contents as text." });
      const format = FORMATS.includes(req.body?.format as ImportFormat) ? (req.body!.format as ImportFormat) : undefined;
      return parseImport(text, { format, filename: str(req.body?.filename, 200), playlist: str(req.body?.playlist, 200) || undefined });
    },
  );

  app.post<{ Body: { items?: unknown; extra?: unknown; limit?: unknown } }>("/api/import/match", { preHandler: requireUser, bodyLimit: MAX_PARSE_BYTES }, async (req, reply) => {
    const raw = req.body?.items;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MATCH_ITEMS) {
      return reply.code(400).send({ error: "invalid_request", message: `Send 1-${MAX_MATCH_ITEMS} tracks per request.` });
    }
    const limit = Math.min(8, Math.max(1, Number(req.body?.limit) || 4));
    const extra = Array.isArray(req.body?.extra) ? req.body.extra.slice(0, MAX_EXTRA).map(cleanExtra).filter((c): c is ExtraCandidate => c !== null) : [];
    const serverIndex = library.get();
    const extraIndex = extra.length ? new CandidateIndex(extra) : null;

    const results = raw.map((item, index) => {
      const wanted = cleanWanted(item);
      if (!wanted) return { index, candidates: [] };
      const ranked: Ranked<LibraryCandidate | ExtraCandidate>[] = [...serverIndex.search(wanted, limit), ...(extraIndex?.search(wanted, limit) ?? [])];
      ranked.sort((a, b) => b.score - a.score);
      const candidates = ranked.slice(0, limit).map((r) => ({
        score: r.score,
        confidence: r.confidence,
        parts: r.parts,
        source: r.candidate.kind,
        id: r.candidate.id,
        track:
          r.candidate.kind === "server"
            ? {
                id: `server:${r.candidate.id}`,
                title: r.candidate.title,
                artists: [{ id: r.candidate.artists[0] ?? "unknown", name: r.candidate.artists[0] ?? "Unknown artist" }],
                album: r.candidate.album,
                durationSec: r.candidate.durationSec,
                source: "server",
              }
            : undefined,
      }));
      return { index, candidates };
    });
    return { thresholds: THRESHOLDS, libraryTracks: serverIndex.size, results };
  });
}

export default playlistImporterPlugin;