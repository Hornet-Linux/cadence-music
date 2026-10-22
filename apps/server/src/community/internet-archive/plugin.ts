import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerPlugin } from "../../plugins/types.js";
import { clampInt, clean, TtlCache } from "../_sourcekit/common.js";
import { envPolicy, envUrl } from "../_sourcekit/env.js";
import { fetchJson, NetError, request } from "../_sourcekit/http.js";
import type { NetPolicy } from "../_sourcekit/netguard.js";
import { netFailureMessage, proxyResponse, singleRange } from "../_sourcekit/proxy.js";
import { nowSec, signedQuery, verifySigned, type SignedParams } from "../_sourcekit/signing.js";
import { isArchiveHost, kindOfFormat, licenceOf, pickTracks, textQuery, validIdentifier, type ArchiveFile, type AudioKind } from "./archive.js";

const ID = "cadence.internet-archive";
const STREAM_TTL_SEC = 6 * 60 * 60;
const IMAGE_TTL_DAYS = 30;
const AUDIO_TYPE = /^(audio\/[\w.+-]+|application\/(ogg|octet-stream))$/i;
const IMAGE_TYPE = /^image\/(jpeg|png|webp|gif)$/i;
const FIELDS = ["identifier", "title", "creator", "date", "year", "downloads", "licenseurl", "mediatype", "collection"];

export interface ArchiveOptions {
  /** Defaults to https://archive.org. Tests point it at a fake. */
  baseUrl?: string;
  policy?: NetPolicy;
  streamIdleMs?: number;
  headerTimeoutMs?: number;
}

interface Doc {
  identifier?: string;
  title?: string | string[];
  creator?: string | string[];
  date?: string;
  year?: string | number;
  downloads?: number;
  licenseurl?: string | string[];
  mediatype?: string;
}

interface Metadata {
  metadata?: Record<string, string | string[] | undefined>;
  files?: ArchiveFile[];
  is_dark?: boolean;
}

const one = (v: string | string[] | undefined, max = 300): string => clean(Array.isArray(v) ? v[0] : v, max);
const strip = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * Search and play from the Internet Archive through its public Advanced Search and Metadata APIs, including the
 * Live Music Archive (the "etree" collection). Audio is streamed through the server from archive.org's download
 * endpoint; items that are lending-library or otherwise access-restricted are never offered. Titles, creators and
 * licences come straight from the item's metadata and are shown with the recording.
 */
export function createArchivePlugin(options: ArchiveOptions = {}): ServerPlugin {
  return {
    id: ID,
    name: "Internet Archive",
    version: "1.0.0",
    register(app, ctx) {
      const { secret, requireUser } = ctx;
      const base = (options.baseUrl ?? envUrl("CADENCE_ARCHIVE_URL") ?? "https://archive.org").replace(/\/+$/, "");
      const baseOrigin = new URL(base).origin;
      const policy: NetPolicy = options.policy ?? envPolicy();
      const headerMs = options.headerTimeoutMs ?? 15_000;
      const idleMs = options.streamIdleMs ?? 30_000;
      const metaCache = new TtlCache<Metadata>(60 * 60_000, 200);
      const searchCache = new TtlCache<unknown>(5 * 60_000, 200);
      const allowRedirect = (_from: URL, to: URL) => to.origin === baseOrigin || isArchiveHost(to.hostname);

      const imagePath = (userId: number, id: string): string => {
        const exp = (Math.floor(nowSec() / 86400) + IMAGE_TTL_DAYS + 1) * 86400;
        return `api/archive/image/${id}?${signedQuery(secret, "archive-image", userId, id, exp)}`;
      };

      function failure(req: FastifyRequest, reply: FastifyReply, e: unknown) {
        if (e instanceof NetError) {
          req.log.warn({ kind: e.kind, detail: e.message }, "archive call failed");
          return reply.code(502).send(netFailureMessage(e.kind));
        }
        req.log.error({ err: e }, "archive handler failed");
        return reply.code(500).send({ error: "internal_error" });
      }

      async function search(q: string, opts: { sort: string; rows: number; page: number }): Promise<{ total: number; docs: Doc[] }> {
        const params = new URLSearchParams();
        params.set("q", q);
        for (const f of FIELDS) params.append("fl[]", f);
        params.append("sort[]", opts.sort);
        params.set("rows", String(opts.rows));
        params.set("page", String(opts.page));
        params.set("output", "json");
        const url = `${base}/advancedsearch.php?${params}`;
        const hit = searchCache.get(url) as { total: number; docs: Doc[] } | undefined;
        if (hit) return hit;
        const r = await fetchJson<{ response?: { numFound?: number; docs?: Doc[] } }>(url, { ...policy, headerTimeoutMs: headerMs, maxBytes: 3_000_000, allowRedirect, maxRedirects: 3 });
        if (r.status >= 400 || !r.json?.response) throw new NetError("bad_response", `HTTP ${r.status}`);
        const out = { total: Number(r.json.response.numFound) || 0, docs: Array.isArray(r.json.response.docs) ? r.json.response.docs : [] };
        searchCache.set(url, out);
        return out;
      }

      const SORTS: Record<string, string> = { downloads: "downloads desc", date: "date desc", oldest: "date asc", title: "titleSorter asc", week: "week desc" };

      function itemOut(userId: number, d: Doc) {
        const id = d.identifier!;
        const licence = licenceOf(one(d.licenseurl, 500));
        const collection = d.mediatype === "collection";
        return {
          id,
          title: one(d.title, 300) || id,
          creator: one(d.creator, 200) || undefined,
          date: clean(d.date, 40).slice(0, 10) || undefined,
          year: d.year ? Number(d.year) || undefined : undefined,
          downloads: Number(d.downloads) || 0,
          kind: collection ? "collection" : d.mediatype === "etree" ? "etree" : "audio",
          licence: licence?.name,
          cover: imagePath(userId, id),
        };
      }

      const NOT_RESTRICTED = "-access-restricted-item:true";

      /** One search entry point for the plain audio library and the Live Music Archive. */
      app.get<{ Querystring: { q?: string; kind?: string; collection?: string; year?: string; sort?: string; page?: string; rows?: string } }>(
        "/api/archive/search",
        { preHandler: requireUser },
        async (req, reply) => {
          const qs = req.query;
          const rows = clampInt(qs.rows, 24, 1, 50);
          const page = clampInt(qs.page, 1, 1, 200);
          const text = textQuery(qs.q);
          const collection = qs.collection && validIdentifier(qs.collection) ? qs.collection : null;
          const year = qs.year && /^\d{4}$/.test(qs.year) ? qs.year : null;
          const kind = qs.kind === "etree" ? "etree" : "audio";
          const parts = [kind === "etree" ? "collection:(etree) AND mediatype:(etree)" : "mediatype:(audio)", NOT_RESTRICTED];
          if (collection) parts.push(`collection:(${collection})`);
          if (year) parts.push(`year:(${year})`);
          if (text) parts.push(text);
          if (!text && !collection && !year && kind === "audio") parts.push("downloads:[1000 TO 99999999]");
          const sort = SORTS[qs.sort ?? ""] ?? (text ? SORTS.downloads : SORTS.downloads);
          try {
            const res = await search(parts.join(" AND "), { sort, rows, page });
            return {
              items: res.docs.filter((d) => validIdentifier(d.identifier)).map((d) => itemOut(req.user!.id, d)),
              total: res.total,
              page,
              hasMore: page * rows < res.total,
            };
          } catch (e) {
            return failure(req, reply, e);
          }
        },
      );

      /** Bands (collections inside the Live Music Archive), most downloaded first. */
      app.get<{ Querystring: { q?: string; page?: string } }>("/api/archive/etree/bands", { preHandler: requireUser }, async (req, reply) => {
        const text = textQuery(req.query.q);
        const parts = ["mediatype:(collection)", "collection:(etree)"];
        if (text) parts.push(text);
        try {
          const res = await search(parts.join(" AND "), { sort: SORTS.downloads, rows: 40, page: clampInt(req.query.page, 1, 1, 50) });
          return { items: res.docs.filter((d) => validIdentifier(d.identifier)).map((d) => itemOut(req.user!.id, d)), total: res.total };
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      // ---- an item: tracks, licence, attribution -------------------------------------------------

      async function metadataOf(id: string): Promise<Metadata> {
        const hit = metaCache.get(id);
        if (hit) return hit;
        const r = await fetchJson<Metadata>(`${base}/metadata/${id}`, { ...policy, headerTimeoutMs: headerMs, maxBytes: 8_000_000, allowRedirect, maxRedirects: 3 });
        if (r.status === 404 || (r.json && Object.keys(r.json).length === 0)) throw new NetError("bad_response", "not found");
        if (r.status >= 400 || !r.json) throw new NetError("bad_response", `HTTP ${r.status}`);
        metaCache.set(id, r.json);
        return r.json;
      }

      const restricted = (m: Metadata): boolean => m.is_dark === true || one(m.metadata?.["access-restricted-item"]) === "true";

      app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/archive/items/:id", { preHandler: requireUser }, async (req, reply) => {
        const id = req.params.id;
        if (!validIdentifier(id)) return reply.code(400).send({ error: "invalid_id" });
        try {
          const m = await metadataOf(id);
          const md = m.metadata ?? {};
          if (restricted(m)) return reply.code(403).send({ error: "restricted", message: "The Internet Archive only offers this one to borrow on its own site" });
          const prefer: AudioKind = req.query.format === "ogg" ? "ogg" : req.query.format === "flac" ? "flac" : "mp3";
          const picked = pickTracks(m.files ?? [], prefer);
          if (!picked) return reply.code(404).send({ error: "no_audio", message: "This item has no audio files to play" });
          const userId = req.user!.id;
          const exp = nowSec() + STREAM_TTL_SEC;
          const title = one(md.title, 300) || id;
          const creator = one(md.creator, 200);
          const licence = licenceOf(one(md.licenseurl, 500));
          const formats = [...new Set((m.files ?? []).map((f) => kindOfFormat(f.format)).filter((k): k is AudioKind => !!k))];
          return {
            id,
            title,
            creator: creator || undefined,
            date: one(md.date, 40).slice(0, 10) || undefined,
            description: strip(one(md.description, 4000)).slice(0, 2000) || undefined,
            venue: one(md.venue, 200) || undefined,
            coverage: one(md.coverage, 200) || undefined,
            taper: one(md.taper, 200) || undefined,
            source: one(md.source, 400) || undefined,
            collections: (Array.isArray(md.collection) ? md.collection : md.collection ? [md.collection] : []).map((c) => clean(c, 80)).slice(0, 8),
            cover: imagePath(userId, id),
            format: picked.kind,
            formats,
            tracks: picked.tracks.map((t) => ({
              title: t.title,
              track: t.track,
              durationSec: t.durationSec,
              size: t.size,
              format: t.format,
              path: `api/archive/stream/${id}?f=${encodeURIComponent(t.file)}&${signedQuery(secret, "archive-stream", userId, `${id}\n${t.file}`, exp)}`,
            })),
            attribution: {
              text: `${title}${creator ? ` by ${creator}` : ""}, from the Internet Archive${licence ? `, ${licence.name}` : ""}`,
              detailsUrl: `https://archive.org/details/${id}`,
              licence: licence ?? undefined,
              rights: one(md.rights, 300) || undefined,
            },
          };
        } catch (e) {
          if (e instanceof NetError && e.kind === "bad_response" && /not found|HTTP 404/.test(e.message)) return reply.code(404).send({ error: "not_found" });
          return failure(req, reply, e);
        }
      });

      /** A fresh signed address for one file (queued tracks outlive the address they were listed with). */
      app.get<{ Querystring: { id?: string; f?: string } }>("/api/archive/stream-url", { preHandler: requireUser }, async (req, reply) => {
        const id = req.query.id;
        const file = req.query.f;
        if (!validIdentifier(id) || typeof file !== "string" || !file || file.length > 300) return reply.code(400).send({ error: "invalid_request" });
        try {
          const m = await metadataOf(id);
          if (restricted(m)) return reply.code(403).send({ error: "restricted" });
          if (!(m.files ?? []).some((f) => f.name === file && kindOfFormat(f.format))) return reply.code(404).send({ error: "not_found" });
          const exp = nowSec() + STREAM_TTL_SEC;
          return { path: `api/archive/stream/${id}?f=${encodeURIComponent(file)}&${signedQuery(secret, "archive-stream", req.user!.id, `${id}
${file}`, exp)}`, expiresAt: exp };
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      // ---- audio and cover art (signed) ------------------------------------------------------------

      app.get<{ Params: { id: string }; Querystring: SignedParams & { f?: string } }>("/api/archive/stream/:id", async (req, reply) => {
        const id = req.params.id;
        const file = typeof req.query.f === "string" ? req.query.f : "";
        if (!validIdentifier(id) || !file || file.length > 300) return reply.code(400).send({ error: "invalid_request" });
        const userId = verifySigned(secret, "archive-stream", `${id}\n${file}`, req.query, nowSec());
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        const ac = new AbortController();
        reply.raw.on("close", () => {
          if (!reply.raw.writableFinished) ac.abort();
        });
        try {
          const m = await metadataOf(id);
          // Only files the item's own metadata lists as audio, never a path someone made up.
          const listed = (m.files ?? []).some((f) => f.name === file && kindOfFormat(f.format));
          if (!listed || restricted(m)) return reply.code(404).send({ error: "not_found" });
          const url = `${base}/download/${id}/${file.split("/").map(encodeURIComponent).join("/")}`;
          const range = singleRange(req);
          const res = await request(url, { ...policy, headers: { Accept: "audio/*, */*;q=0.5", ...(range ? { Range: range } : {}) }, idleTimeoutMs: 0, headerTimeoutMs: headerMs, maxRedirects: 5, allowRedirect, signal: ac.signal });
          return proxyResponse(req, reply, res, { accept: AUDIO_TYPE, cache: "private, max-age=3600", idleMs });
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      app.get<{ Params: { id: string }; Querystring: SignedParams }>("/api/archive/image/:id", async (req, reply) => {
        const id = req.params.id;
        if (!validIdentifier(id)) return reply.code(400).send({ error: "invalid_id" });
        if (verifySigned(secret, "archive-image", id, req.query, nowSec()) === null) return reply.code(403).send({ error: "invalid_signature" });
        try {
          const res = await request(`${base}/services/img/${id}`, { ...policy, headers: { Accept: "image/*" }, headerTimeoutMs: 10_000, maxRedirects: 3, allowRedirect });
          return proxyResponse(req, reply, res, { accept: IMAGE_TYPE, cache: "private, max-age=86400", idleMs, extraHeaders: { "Content-Security-Policy": "default-src 'none'; sandbox" } });
        } catch (e) {
          if (e instanceof NetError) return reply.code(404).send({ error: "not_found" });
          return failure(req, reply, e);
        }
      });
    },
  };
}

export default createArchivePlugin();