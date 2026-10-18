import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves the web player (the desktop UI built with `npm run build:web`) at
 * /app. Unknown paths fall back to index.html so in-app routes and sign-in
 * callbacks load the app.
 */
export function registerWebApp(app: FastifyInstance, webDir: string | undefined): void {
  const root = webDir ? path.resolve(webDir) : null;
  const index = root ? path.join(root, "index.html") : null;
  const available = !!index && fs.existsSync(index);

  app.get("/app", async (_req, reply) => reply.redirect("/app/"));

  app.get<{ Params: { "*": string } }>("/app/*", async (req, reply) => {
    if (!available || !root || !index) {
      return reply.code(404).type("text/plain").send("The web player isn't installed on this server.");
    }
    let rel: string;
    try {
      rel = decodeURIComponent(req.params["*"] ?? "");
    } catch {
      return reply.code(400).send();
    }
    const file = path.resolve(root, rel);
    const inside = file === root || file.startsWith(root + path.sep);
    if (inside && rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return sendFile(reply, file, rel.startsWith("assets/"));
    }
    // Asset requests that miss are real 404s; everything else is an app route.
    if (rel.startsWith("assets/")) return reply.code(404).send();
    return sendFile(reply, index, false);
  });
}

function sendFile(reply: FastifyReply, file: string, immutable: boolean) {
  reply
    .type(TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream")
    .header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
    .header("X-Frame-Options", "DENY")
    .header("Referrer-Policy", "no-referrer");
  return reply.send(fs.createReadStream(file));
}
