// Runs the real server (same code as dist/index.js) but points the Google Drive / OneDrive plugin at the test
// doubles from sources-fakes.mjs instead of Google and Microsoft. For hand and browser testing only: the real
// plugin always talks to the real services. Mount this file into the Docker image next to dist/:
//
//   docker run ... -v ./scripts/sources-e2e-server.mjs:/app/e2e.mjs \
//     -e FAKE_CLOUD_URL=http://host.docker.internal:9253 -e FAKE_CLOUD_BROWSER_URL=http://localhost:9253 \
//     cadence-server:tag node --disable-warning=ExperimentalWarning /app/e2e.mjs
//
// Everything else (auto-discovery of community plugins, the on/off setting, routes) is the normal path.
import fs from "node:fs";
import path from "node:path";
import { buildApp, builtinPlugins } from "./dist/app.js";
import { loadConfig, loadOrCreateSecret } from "./dist/config.js";
import { openDb } from "./dist/db.js";
import { createLocalUser, findUserByUsername } from "./dist/auth/users.js";
import { Settings } from "./dist/settings.js";
import { loadCommunityPlugins } from "./dist/plugins/community.js";
import { createCloudDrivePlugin } from "./dist/community/onedrive-gdrive/plugin.js";

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const secret = loadOrCreateSecret(config.dataDir);
const db = openDb(path.join(config.dataDir, "music.db"));
if (config.adminUsername && config.adminPassword && !findUserByUsername(db, config.adminUsername)) {
  await createLocalUser(db, { username: config.adminUsername, password: config.adminPassword, isAdmin: true });
}

const fake = process.env.FAKE_CLOUD_URL;
const browser = process.env.FAKE_CLOUD_BROWSER_URL ?? fake;
const settings = new Settings(db, config);
const log = { error: console.error, warn: console.warn, info: console.log, debug() {}, child() { return this; } };
const community = (await loadCommunityPlugins(log))
  .filter((p) => settings.pluginEnabled(p.id))
  .map((p) =>
    p.id === "cadence.onedrive-gdrive" && fake
      ? createCloudDrivePlugin({
          endpoints: {
            google: { authorize: `${browser}/google/authorize`, token: `${fake}/google/token`, api: `${fake}/google/api` },
            microsoft: { authorize: `${browser}/ms/authorize`, token: `${fake}/ms/token`, api: `${fake}/ms/api` },
          },
        })
      : p,
  );

const app = await buildApp({ config, db, secret, plugins: [...builtinPlugins, ...community], onSetupCode: () => undefined });
console.log("community plugins on:", community.map((p) => p.id).join(", ") || "none");
await app.listen({ host: config.host, port: config.port });
