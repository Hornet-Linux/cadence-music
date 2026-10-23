import { RateLimiter } from "../../auth/rateLimit.js";
import { open, seal } from "../../llm/secretBox.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { registerNetworkAdminRoutes } from "../../sources/adminRoutes.js";
import { RemoteError } from "../../sources/indexer.js";
import { parseSourceUrl, precheckUrl, readHead, SourceNetError } from "../../sources/net.js";
import { networkPolicy } from "../../sources/policy.js";
import { SourceRuntime, type RuntimeOptions } from "../../sources/runtime.js";
import { isPathStyleByDefault, listPrefixes, normalizePrefix, openObject, regionHint, testBucket, walkAudio, type S3Connection } from "./client.js";

export const S3_PLUGIN_ID = "cadence.s3";
const PURPOSE = "cadence-s3-secret-keys";
const MAX_FOLDERS = 50;

/** What is saved for a person (settings.pluginUserConfig). The secret key is sealed with the server secret. */
interface Stored {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretEnc: string;
  pathStyle: boolean;
  /** Key prefixes to index; empty means the whole bucket. */
  folders: string[];
}

interface Conn extends S3Connection {
  folders: string[];
}

export interface S3PluginOptions {
  runtime?: RuntimeOptions;
  env?: NodeJS.ProcessEnv;
  maxConnectAttempts?: number;
  /** Tests move the clock to check that streaming links are short-lived. */
  now?: () => Date;
}

function cleanFolders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_FOLDERS) return null;
  const out: string[] = [];
  for (const raw of value) {
    const p = typeof raw === "string" ? normalizePrefix(raw) : null;
    if (p === null) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * S3-compatible object storage as a music source: AWS S3, MinIO, Backblaze B2, Cloudflare R2 and friends.
 * Each person saves an access key for a bucket (a read-only key is enough); the server lists the chosen
 * prefixes, caches the tracks and streams objects through itself with short-lived signed requests that
 * never leave the server.
 */
export function createS3Plugin(options: S3PluginOptions = {}): ServerPlugin {
  return {
    id: S3_PLUGIN_ID,
    name: "S3-compatible storage (AWS, MinIO, B2, R2)",
    version: "1.0.0",
    description:
      "Play music from S3-compatible storage (AWS S3, MinIO, Backblaze B2, Cloudflare R2). Each person adds their own bucket and keys; secret keys are stored encrypted on this server.",
    configFields: [],
    configNote: "Nothing to set here. Each person adds their bucket in the player under Settings > Plugins.",
    register(app, ctx) {
      const { settings, secret, requireUser } = ctx;
      const policy = () => networkPolicy(settings, options.env);
      const now = options.now ?? (() => new Date());
      const limiter = new RateLimiter({ max: options.maxConnectAttempts ?? 10, windowMs: 10 * 60_000 });

      const read = (userId: number): Conn | null => {
        const stored = settings.pluginUserConfig<Stored>(S3_PLUGIN_ID, userId);
        if (!stored) return null;
        const secretAccessKey = open(stored.secretEnc, secret, PURPOSE);
        if (secretAccessKey === null) {
          // Sealed with a different server secret, or damaged: it can't be used, so the person connects again.
          settings.setPluginUserConfig(S3_PLUGIN_ID, userId, null);
          return null;
        }
        return {
          endpoint: stored.endpoint,
          region: stored.region,
          bucket: stored.bucket,
          pathStyle: stored.pathStyle,
          credentials: { accessKeyId: stored.accessKeyId, secretAccessKey },
          folders: stored.folders,
        };
      };

      const runtime = new SourceRuntime<Conn>(
        ctx,
        {
          area: "s3",
          source: "s3",
          label: "S3 storage",
          pluginId: S3_PLUGIN_ID,
          connection: read,
          describe: (_userId, c) => ({
            endpoint: c.endpoint ?? null,
            region: c.region,
            bucket: c.bucket,
            accessKeyId: c.credentials.accessKeyId,
            folders: c.folders,
          }),
          driver: (_userId, c) => ({
            list: (signal) => walkAudio(c, c.folders, policy(), signal, now),
            readHead: async (file, bytes, signal) => {
              const res = await openObject(c, file.path, `bytes=0-${bytes - 1}`, policy(), signal, now);
              if (res.status !== 200 && res.status !== 206) {
                res.body.destroy();
                throw res.status === 404 ? new RemoteError("not_found") : new RemoteError("upstream", undefined, res.status);
              }
              return readHead(res, bytes);
            },
          }),
          open: (_userId, c, track, range, signal) => openObject(c, track.path, range, policy(), signal, now),
          disconnect: (userId) => settings.setPluginUserConfig(S3_PLUGIN_ID, userId, null),
        },
        options.runtime,
      );
      runtime.register(app);
      registerNetworkAdminRoutes(app, ctx, "s3", options.env);

      app.put<{ Body: Record<string, unknown> }>("/api/s3/connection", { preHandler: requireUser }, async (req, reply) => {
        const userId = req.user!.id;
        const key = `u${userId}`;
        if (limiter.isLimited(key)) return reply.code(429).send({ error: "too_many_attempts", message: "Too many attempts. Try again in a few minutes." });
        const b = req.body ?? {};
        const text = (v: unknown, max: number) => (typeof v === "string" && v.trim().length <= max ? v.trim() : "");
        const bad = (message: string) => reply.code(400).send({ error: "bad_request", message });
        const endpointText = text(b.endpoint, 2048);
        const region = text(b.region, 40) || (endpointText ? "auto" : "us-east-1");
        const bucket = text(b.bucket, 63);
        const accessKeyId = text(b.accessKeyId, 128);
        const secretAccessKey = typeof b.secretAccessKey === "string" ? b.secretAccessKey.trim() : "";
        if (!/^[A-Za-z0-9-]{2,40}$/.test(region)) return bad("That region isn't valid. Use a name like us-east-1 (or auto for Cloudflare R2).");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/.test(bucket)) return bad("Enter the bucket name");
        if (!/^[\w+=,.@-]{4,128}$/.test(accessKeyId)) return bad("Enter the access key ID");
        if (!secretAccessKey || secretAccessKey.length > 200) return bad("Enter the secret access key");
        const folders = b.folders === undefined ? [] : cleanFolders(b.folders);
        if (folders === null) return bad("Those folders aren't valid");
        if (b.pathStyle !== undefined && typeof b.pathStyle !== "boolean") return bad("pathStyle must be true or false");
        limiter.hit(key);
        try {
          let endpoint: string | undefined;
          if (endpointText) {
            const url = parseSourceUrl(endpointText, "S3 endpoint");
            precheckUrl(url, policy());
            endpoint = url.origin + url.pathname.replace(/\/+$/, "");
          }
          const pathStyle = typeof b.pathStyle === "boolean" ? b.pathStyle : isPathStyleByDefault(endpoint, bucket);
          const conn: Conn = { endpoint, region, bucket, pathStyle, credentials: { accessKeyId, secretAccessKey }, folders };
          await testBucket(conn, policy(), undefined, now);
          const stored: Stored = { endpoint, region, bucket, accessKeyId, secretEnc: seal(secretAccessKey, secret, PURPOSE), pathStyle, folders };
          await runtime.stop(userId);
          const prev = settings.pluginUserConfig<Stored>(S3_PLUGIN_ID, userId);
          settings.setPluginUserConfig(S3_PLUGIN_ID, userId, stored);
          if (prev && (prev.endpoint !== endpoint || prev.bucket !== bucket || prev.accessKeyId !== accessKeyId)) runtime.store.clear(userId);
          void runtime.index(userId).catch(() => undefined);
          return { connected: true, endpoint: endpoint ?? null, region, bucket, accessKeyId, folders };
        } catch (e) {
          const hint = regionHint(e);
          if (hint !== null) {
            return reply.code(400).send({
              error: "s3_wrong_region",
              message: hint ? `That bucket is in the region ${hint}. Change the region and try again.` : "The region doesn't match the bucket. Check the region and try again.",
            });
          }
          if (e instanceof RemoteError && e.code === "auth_failed") {
            return reply.code(400).send({ error: "s3_bad_credentials", message: "The storage service refused that key. Check the access key ID, the secret and that the key can read this bucket." });
          }
          if (e instanceof RemoteError && e.code === "not_found") {
            return reply.code(400).send({ error: "s3_no_bucket", message: "That bucket doesn't exist at this address" });
          }
          if (e instanceof RemoteError && e.code === "bad_response") {
            return reply.code(400).send({ error: "s3_not_s3", message: "That address didn't answer like S3 storage" });
          }
          if (e instanceof SourceNetError || e instanceof RemoteError) return runtime.failure(reply, e, userId);
          throw e;
        }
      });

      app.get<{ Querystring: { path?: string } }>("/api/s3/folders", { preHandler: requireUser }, async (req, reply) => {
        const userId = req.user!.id;
        const conn = read(userId);
        if (!conn) return reply.code(409).send({ error: "s3_not_connected", message: "Connect S3 storage first" });
        const here = normalizePrefix(req.query.path ?? "");
        if (here === null) return reply.code(400).send({ error: "bad_request", message: "That folder isn't valid" });
        try {
          return { path: here, folders: await listPrefixes(conn, here, policy(), undefined, now) };
        } catch (e) {
          return runtime.failure(reply, e, userId);
        }
      });

      app.put<{ Body: { folders?: unknown } }>("/api/s3/folders", { preHandler: requireUser }, async (req, reply) => {
        const userId = req.user!.id;
        const stored = settings.pluginUserConfig<Stored>(S3_PLUGIN_ID, userId);
        if (!stored) return reply.code(409).send({ error: "s3_not_connected", message: "Connect S3 storage first" });
        const folders = cleanFolders(req.body?.folders);
        if (folders === null) return reply.code(400).send({ error: "bad_request", message: "Those folders aren't valid" });
        settings.setPluginUserConfig(S3_PLUGIN_ID, userId, { ...stored, folders });
        void runtime.restart(userId).catch(() => undefined);
        return { folders };
      });
    },
  };
}

export default createS3Plugin();
