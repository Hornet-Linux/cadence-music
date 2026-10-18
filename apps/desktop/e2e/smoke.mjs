// Launch the built desktop app and check that it really works end to end:
// the preload bridge loads, built-in plugins render, settings open, and the
// Widevine CDM (needed for Spotify / Apple Music) is available.
//
//   npm run build && npm run e2e        (Linux CI runs this under xvfb-run)
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const app = await electron.launch({
  args: ["--no-sandbox", appDir],
  cwd: appDir,
  timeout: 90_000,
});

try {
  const page = await app.firstWindow({ timeout: 90_000 });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[renderer] ${msg.text()}`);
  });
  page.on("pageerror", (err) => console.log(`[renderer exception] ${err.message}`));

  await page.waitForSelector(".titlebar", { timeout: 60_000 });

  const bridge = await page.evaluate(() => ({
    secrets: typeof window.host?.secrets?.get,
    oidc: typeof window.host?.auth?.oidcLogin,
    spotify: typeof window.host?.spotify?.token,
  }));
  assert.deepEqual(
    bridge,
    { secrets: "function", oidc: "function", spotify: "function" },
    "the preload bridge (window.host) did not load",
  );

  for (const label of ["Home", "Server", "Spotify", "Apple Music", "Local Files", "Settings"]) {
    await page.getByRole("button", { name: label, exact: true }).first().waitFor({ timeout: 15_000 });
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const heading of ["Server", "Spotify", "Apple Music", "Plugins"]) {
    await page.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 10_000 });
  }

  const widevine = await page.evaluate(async () => {
    try {
      await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [
        {
          initDataTypes: ["cenc"],
          audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
        },
      ]);
      return true;
    } catch (err) {
      return String(err);
    }
  });
  assert.equal(widevine, true, `Widevine is unavailable: ${widevine}`);

  console.log("Desktop smoke test passed (bridge, plugins, settings, Widevine)");
} finally {
  await app.close();
}
