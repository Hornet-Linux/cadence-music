import fs from "node:fs";
import path from "node:path";
import { buildApp } from "./app.js";
import { loadConfig, loadOrCreateSecret } from "./config.js";
import { openDb } from "./db.js";
import { createLocalUser, findUserByUsername } from "./auth/users.js";

async function main() {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const secret = loadOrCreateSecret(config.dataDir);
  const db = openDb(path.join(config.dataDir, "music.db"));

  // Bootstrap an admin account from the environment on first start.
  if (config.adminUsername && config.adminPassword) {
    if (!findUserByUsername(db, config.adminUsername)) {
      createLocalUser(db, {
        username: config.adminUsername,
        password: config.adminPassword,
        isAdmin: true,
      });
    }
  }

  const app = await buildApp({
    config,
    db,
    secret,
    // Printed plainly so `docker compose logs server | grep "setup code"` finds it.
    onSetupCode: (code) => {
      console.log(
        [
          "",
          "==================================================================",
          `  First-run setup code: ${code}`,
          "  Open the desktop app, connect to this server and enter the code",
          "  to create the admin account. It works once and is gone after a",
          "  restart once an account exists.",
          "==================================================================",
          "",
        ].join("\n"),
      );
    },
  });

  if (!fs.existsSync(config.musicDir)) {
    app.log.warn({ musicDir: config.musicDir }, "MUSIC_DIR does not exist; the library will be empty");
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
