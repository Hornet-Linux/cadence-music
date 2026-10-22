// Launch the built desktop app and check that it really works end to end:
// the preload bridge loads, built-in plugins render, settings open, and the
// Widevine CDM (needed for Spotify / Apple Music) is available.
//
//   npm run build && npm run e2e        (Linux CI runs this under xvfb-run)
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
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
  // Scope to the dialog: the player bar also has a "Next" (track) button.
  const wizard = page.getByRole("dialog");
  await wizard.getByRole("heading", { name: "Welcome to Cadence" }).waitFor({ timeout: 15_000 });
  if (process.env.E2E_SCREENSHOTS === "1") {
    const shots = path.join(appDir, "e2e", "screenshots");
    fs.mkdirSync(shots, { recursive: true });
    await page.waitForTimeout(2000); // let the entrance animation finish
    await page.screenshot({ path: path.join(shots, "0-setup-wizard.png") });
  }
  await wizard.getByRole("button", { name: "Get started", exact: true }).click();
  for (const title of ["Connect your server", "Connect Spotify", "Connect Apple Music", "Connect Jellyfin"]) {
    await wizard.getByRole("heading", { name: title, exact: true }).waitFor({ timeout: 10_000 });
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
  }
  await wizard.getByRole("heading", { name: "You're all set", exact: true }).waitFor({ timeout: 10_000 });
  await wizard.getByRole("button", { name: "Start listening", exact: true }).click();
  await page.locator(".wizard-backdrop").waitFor({ state: "detached", timeout: 10_000 });

  // The rail has the everyday pages; pages added by plugins live behind "More".
  for (const label of ["Home", "Search", "Library", "Favourites", "More", "Settings"]) {
    await page.getByRole("button", { name: label, exact: true }).first().waitFor({ timeout: 15_000 });
  }
  await page.getByRole("button", { name: "More", exact: true }).click();
  const more = page.locator(".more-sheet");
  for (const label of ["Server", "Spotify", "Apple Music", "Local Files"]) {
    await more.getByRole("button", { name: label, exact: true }).waitFor({ timeout: 10_000 });
  }
  // Jellyfin is a built-in plugin too; accept it being absent on builds without it.
  console.log(`Jellyfin page in More: ${(await more.getByRole("button", { name: "Jellyfin", exact: true }).count()) > 0}`);
  await page.keyboard.press("Escape");
  await more.waitFor({ state: "detached", timeout: 5_000 });


  // ---- Settings window -----------------------------------------------------
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog");
  for (const section of ["Playback", "Appearance", "Server", "Spotify", "Apple Music", "Plugins", "About"]) {
    await settings.getByRole("button", { name: section, exact: true }).click();
    await settings.locator("#settings-title", { hasText: section }).waitFor({ timeout: 10_000 });
  }
  // Search narrows the categories.
  await settings.getByRole("textbox", { name: "Search settings" }).fill("accent");
  await settings.locator("#settings-title", { hasText: "Appearance" }).waitFor({ timeout: 5_000 });
  assert.equal(await settings.getByRole("button", { name: "Playback", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await page.locator(".modal-backdrop").waitFor({ state: "detached", timeout: 5_000 });

  console.log("UI smoke test passed (bridge, wizard, plugins, settings)");

  // ---- Screenshots with sample data -----------------------------------------
  // Seeds local history and a restored queue so the design can be reviewed
  // with real-looking content (artwork from picsum.photos).
  if (process.env.E2E_SCREENSHOTS === "1") {
    const shots = path.join(appDir, "e2e", "screenshots");
    fs.mkdirSync(shots, { recursive: true });

    await page.evaluate(() => {
      const names = [
        ["Midnight Static", "Neon Harbor"],
        ["Glass Avenue", "Vela Nine"],
        ["Paper Satellites", "Mono Atlas"],
        ["Velvet Hour", "Room 214"],
        ["Undertow", "Kaskade Reef"],
        ["Golden Static", "The Hour Hand"],
        ["Cassette Sun", "Lumen Drive"],
        ["Low Orbit", "Mono Atlas"],
        ["Afterglow", "Vela Nine"],
        ["Tidal Lines", "Kaskade Reef"],
      ];
      const tracks = names.map(([title, artist], i) => ({
        id: `spotify:track:demo${i}`,
        title,
        artists: [{ id: artist, name: artist }],
        album: `${title} (Deluxe)`,
        artwork: `https://picsum.photos/seed/uma-${i + 3}/400`,
        durationSec: 180 + i * 17,
        source: "spotify",
      }));
      const now = Date.now();
      const plays = [];
      // Varying play counts so "Most played" has a ranking.
      tracks.forEach((track, i) => {
        for (let n = 0; n < 10 - i; n++) plays.push({ track, playedAt: now - (i * 13 + n) * 3_600_000 });
      });
      plays.sort((a, b) => b.playedAt - a.playedAt);
      localStorage.setItem("history:plays", JSON.stringify(plays));
      localStorage.setItem("player:session", JSON.stringify({ queue: tracks, index: 2, position: 74 }));
    });
    await page.reload();
    await page.waitForSelector(".hero", { timeout: 20_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(2500); // let the art colour transition settle
    await page.screenshot({ path: path.join(shots, "1-home.png") });

    await page.getByRole("button", { name: "Queue", exact: true }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, "2-queue.png") });
    await page.getByRole("button", { name: "Queue", exact: true }).click();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, "3-settings-playback.png") });
    await page.getByRole("dialog").getByRole("button", { name: "Appearance", exact: true }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, "4-settings-appearance.png") });
    await page.getByRole("dialog").getByRole("button", { name: "Spotify", exact: true }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, "5-settings-spotify.png") });
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, "6-search.png") });
    console.log(`Screenshots saved to ${shots}`);
  }
} finally {
  await app.close();
}

// ---- DRM check without a debugger attached --------------------------------
const probe = spawnSync(electronPath, ["--no-sandbox", appDir, "--widevine-probe"], {
  cwd: appDir,
  encoding: "utf8",
  timeout: 150_000,
});
const line = `${probe.stdout}\n${probe.stderr}`.split("\n").find((l) => l.includes("WIDEVINE_PROBE "));
if (!line) {
  console.log(probe.stdout, probe.stderr, probe.error ?? "");
  assert.fail("the --widevine-probe run printed no result");
}
const result = JSON.parse(line.slice(line.indexOf("WIDEVINE_PROBE ") + "WIDEVINE_PROBE ".length));
console.log("Widevine probe:", JSON.stringify(result));

if (process.env.E2E_REQUIRE_WIDEVINE === "1") {
  // Required where the app ships (Windows).
  assert.equal(result.keySystem, true, `Widevine is unavailable: ${JSON.stringify(result)}`);
  console.log("Widevine DRM is available");
} else if (result.keySystem !== true) {
  console.warn("Widevine is not available on this platform; DRM playback was not checked.");
}
