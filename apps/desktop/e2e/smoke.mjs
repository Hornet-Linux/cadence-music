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

// Surface main-process logs (Widevine install messages, errors).
const proc = app.process();
proc.stdout?.on("data", (d) => process.stdout.write(`[main] ${d}`));
proc.stderr?.on("data", (d) => process.stdout.write(`[main:err] ${d}`));

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

  // A first launch opens the setup wizard: walk through every step.
  await page.getByRole("heading", { name: "Welcome to Unnamed Music App" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  for (const title of ["Connect your server", "Connect Spotify", "Connect Apple Music"]) {
    await page.getByRole("heading", { name: title, exact: true }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
  await page.getByRole("heading", { name: "You're all set", exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Start listening", exact: true }).click();
  await page.locator(".wizard-backdrop").waitFor({ state: "detached", timeout: 10_000 });

  for (const label of ["Home", "Server", "Spotify", "Apple Music", "Local Files", "Settings"]) {
    await page.getByRole("button", { name: label, exact: true }).first().waitFor({ timeout: 15_000 });
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const heading of ["Server", "Spotify", "Apple Music", "Plugins"]) {
    await page.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 10_000 });
  }

  // castlabs installs the Widevine CDM through Chromium's component updater.
  const components = await app.evaluate(async (electron) => {
    const c = electron.components;
    if (!c) return { castlabs: false };
    const ready = await Promise.race([
      c.whenReady().then(() => "ready", (err) => `failed: ${err}`),
      new Promise((r) => setTimeout(() => r("timeout"), 60_000)),
    ]);
    return { castlabs: true, ready, status: c.status() };
  });
  console.log("castlabs components:", JSON.stringify(components));

  const widevine = await page.evaluate(async () => {
    const configs = [
      { label: "audio/mp4 aac", audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] },
      { label: "audio/webm opus", audioCapabilities: [{ contentType: 'audio/webm; codecs="opus"' }] },
      { label: "no capabilities", audioCapabilities: [] },
    ];
    const results = {};
    for (const { label, audioCapabilities } of configs) {
      try {
        await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [
          { initDataTypes: ["cenc"], audioCapabilities },
        ]);
        results[label] = true;
      } catch (err) {
        results[label] = String(err);
      }
    }
    return results;
  });
  console.log("Widevine probe:", JSON.stringify(widevine));
  const hasWidevine = Object.values(widevine).some((v) => v === true);
  // Required where the app ships (Windows); castlabs provides no CDM on Linux CI.
  if (process.env.E2E_REQUIRE_WIDEVINE === "1") {
    assert.ok(hasWidevine, `Widevine is unavailable: ${JSON.stringify(widevine)}`);
  } else if (!hasWidevine) {
    console.warn("Widevine is not available on this platform; DRM playback was not checked.");
  }

  console.log(`Desktop smoke test passed (bridge, wizard, plugins, settings${hasWidevine ? ", Widevine" : ""})`);
} finally {
  await app.close();
}
