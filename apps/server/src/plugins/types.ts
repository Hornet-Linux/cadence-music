import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { UserRow } from "../auth/users.js";
import type { Settings } from "../settings.js";
import type { Jobs, ServerEvents } from "./runtime.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the `requireUser` / `requireAdmin` pre-handlers. */
    user: UserRow | null;
  }
}

export type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** What the server hands each plugin when it registers. */
export interface ServerPluginContext {
  db: Db;
  config: Config;
  /** Server secret, e.g. for signing URLs. */
  secret: string;
  log: FastifyBaseLogger;
  /** Pre-handler that rejects requests without a valid session. */
  requireUser: PreHandler;
  /** Pre-handler that also requires the user to be an admin. */
  requireAdmin: PreHandler;
  /** Runtime settings an admin can change (they override .env). */
  settings: Settings;
  /** Typed events other plugins emit, e.g. `play.recorded` for scrobblers. */
  events: ServerEvents;
  /** Background jobs that stop with the server. */
  jobs: Jobs;
}

/** One setting on a plugin's admin form. Keys named like secrets are hidden when shown again. */
export interface PluginConfigField {
  key: string;
  label: string;
  type?: "text" | "password" | "number" | "boolean" | "url";
  help?: string;
  placeholder?: string;
}

/**
 * A server plugin adds routes, background jobs or hooks. Built-in features such
 * as the music library are plugins too, so third-party plugins use the same
 * seam. Plugins should keep their routes under `/api/<area>`.
 */
export interface ServerPlugin {
  id: string;
  name: string;
  version: string;
  /** One sentence for the admin panel's Plugins page. */
  description?: string;
  /**
   * Settings the admin can fill in on the Plugins page (stored with `settings.pluginConfig(id)`).
   * Without it the page offers a plain JSON editor.
   */
  configFields?: PluginConfigField[];
  register: (app: FastifyInstance, ctx: ServerPluginContext) => void | Promise<void>;
}
