import type { FastifyInstance, FastifyReply } from "fastify";
import { CLIENT_KIT, sendPage } from "../web/pageKit.js";
import { ADMIN_A } from "./adminClientA.js";
import { ADMIN_B } from "./adminClientB.js";
import { ADMIN_C } from "./adminClientC.js";

// The admin panel at /admin: a self-contained page that talks to the /api/admin
// endpoints with an admin's session token. All user data is put in the DOM as
// text nodes, never as HTML. The browser code lives in the adminClient* files.

const SCRIPT = `(() => {\n${CLIENT_KIT}\n${ADMIN_A}\n${ADMIN_B}\n${ADMIN_C}\n})();`;

export function registerAdminPage(app: FastifyInstance): void {
  const handler = async (_req: unknown, reply: FastifyReply) =>
    sendPage(reply, { title: "Cadence admin", body: '<div id="app"></div>', script: SCRIPT });
  app.get("/admin", handler);
  app.get("/admin/", handler);
}