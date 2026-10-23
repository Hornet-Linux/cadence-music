// End-to-end test of the web player against a running server container:
// sign up on the landing page, sign in through the web player's first-run
// screen (which closes itself once you are signed in), find a track from the
// server's library and play it. Fails on page errors and CSP
// violations. Screenshots go to $SHOTS.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:18788";
const SHOTS = process.env.SHOTS ?? "web-screenshots";
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const problems = [];
page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
});
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

try {
  // ---- Landing page sign-up ----------------------------------------------
  await page.goto(`${BASE}/`);
  await page.getByRole("heading", { name: "Create your account" }).waitFor();
  await shot("1-landing");
  await page.getByLabel("Your name").fill("Web Tester");
  await page.getByLabel("Username").fill("webtester");
  await page.getByLabel("Password", { exact: true }).fill("web-test-password");
  await page.getByLabel("Repeat password").fill("web-test-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("You're in, Web Tester!").waitFor({ timeout: 10_000 });
  await shot("2-signed-up");
  console.log("✓ signed up on the landing page");

  // ---- Web player: first run + sign-in -------------------------------------
  // The page is served by the user's own server, so the wizard only asks for a
  // sign-in (no server address, no "files on this computer", no deploy script).
  await page.getByRole("link", { name: "Open the web player" }).click();
  await page.waitForURL(`${BASE}/app/`);
  const wizard = page.getByRole("dialog");
  await wizard.getByRole("heading", { name: "Welcome to Cadence" }).waitFor({ timeout: 15_000 });
  const welcome = await wizard.innerText();
  assert.ok(!/files on this computer|setup.sh/i.test(welcome), `the web wizard shows desktop-only text:
${welcome}`);
  await wizard.getByRole("button", { name: "Get started", exact: true }).click();
  await wizard.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  await wizard.getByPlaceholder("Username").fill("webtester");
  await wizard.getByPlaceholder("Password").fill("web-test-password");
  await shot("3-wizard-sign-in");
  await wizard.getByRole("button", { name: "Sign in", exact: true }).click();
  // Signed in to the server that serves the page: nothing left to set up, so the wizard closes by itself.
  await page.locator(".wizard-backdrop").waitFor({ state: "detached", timeout: 10_000 });
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.getByRole("button", { name: "Library", exact: true }).waitFor();
  await shot("3-home-signed-in");
  console.log("✓ signed in from the web player's first-run screen; the wizard closed and Home is showing");

  // A signed-in visitor is never blocked by the wizard, even on a first run.
  await page.evaluate(() => localStorage.removeItem("onboarding:done"));
  await page.reload();
  await page.getByRole("button", { name: "Library", exact: true }).waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator(".wizard-backdrop").count(), 0, "the wizard blocked a signed-in visitor");
  console.log("✓ no wizard for a signed-in visitor");

  // ---- Library + playback ---------------------------------------------------
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("heading", { name: "Your Library" }).waitFor();
  await page.getByRole("button", { name: "Play Smoke Test" }).first().click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor({ timeout: 15_000 });
  await page.locator(".playerbar .tt", { hasText: "Smoke Test" }).waitFor();
  // The position must actually advance: the audio is really playing.
  const before = await page.locator(".seek .time").first().textContent();
  await page.waitForTimeout(2200);
  const later = await page.locator(".seek .time").first().textContent();
  assert.notEqual(later, before, `playback position did not advance (${before} → ${later})`);
  await shot("4-playing");
  console.log(`✓ played a server track in the browser (${before} → ${later})`);

  // ---- Session survives a reload --------------------------------------------
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Server", exact: true }).click();
  await page.getByRole("dialog").getByText("Web Tester").first().waitFor({ timeout: 10_000 });
  console.log("✓ still signed in after a reload");
  await page.keyboard.press("Escape");

  // ---- Liked songs and playlists, synced through the server -----------------
  await page.locator(".playerbar").getByRole("button", { name: "Add Smoke Test to Liked Songs" }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "New playlist" }).first().click();
  await page.getByRole("textbox", { name: "New playlist name" }).fill("Road trip");
  await page.keyboard.press("Enter");
  await page.locator(".collection-title", { hasText: "Road trip" }).waitFor();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Add Smoke Test to a playlist" }).first().click();
  await page.getByRole("menuitem", { name: "Road trip" }).click();
  // Forget this browser's copy: what comes back must come from the server.
  await page.waitForTimeout(1000);
  await page.evaluate(() => localStorage.removeItem("collection:v1"));
  await page.reload();
  await page.getByRole("button", { name: "Favourites", exact: true }).click();
  await page.locator(".track-row", { hasText: "Smoke Test" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.locator(".collection-tile", { hasText: "Road trip" }).click();
  await page.locator(".track-row", { hasText: "Smoke Test" }).waitFor({ timeout: 15_000 });
  await shot("5-playlist");
  console.log("✓ liked a song and made a playlist; both came back from the server");

  // ---- Phone layout (as in the Android and iOS apps) --------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("heading", { name: "Your Library" }).waitFor();
  const tabBar = await page.locator(".tabbar").boundingBox();
  assert.ok(tabBar && tabBar.y > 700, `expected the nav as a bottom tab bar on phones (y=${tabBar?.y})`);
  const tabs = await page.locator(".tabbar .tab").evaluateAll((els) => els.map((e) => e.textContent?.trim()));
  assert.deepEqual(tabs, ["Home", "Search", "Library", "Favourites", "More"], "the phone tab bar should have five tabs");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `the phone layout scrolls sideways by ${overflow}px`);
  await shot("5-phone-library");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await shot("6-phone-home");
  // Plugin pages and Settings are reachable from the More sheet.
  await page.getByRole("button", { name: "More", exact: true }).click();
  const sheet = page.locator(".more-sheet");
  await sheet.getByRole("button", { name: "Server", exact: true }).waitFor();
  await shot("7-phone-more");
  await sheet.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Server", exact: true }).click();
  await shot("8-phone-settings");
  console.log("✓ phone layout: five-tab bottom bar, More sheet, no sideways scrolling");

  const relevant = problems.filter((p) => !/favicon/i.test(p));
  assert.deepEqual(relevant, [], `the page reported problems:\n${relevant.join("\n")}`);
  console.log("Web player end-to-end test passed");
} finally {
  await browser.close();
}
