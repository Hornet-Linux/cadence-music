// End-to-end test of the web player against a running server container:
// sign up on the landing page, sign in through the app's setup wizard, find a
// track from the server's library and play it. Fails on page errors and CSP
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

  // ---- Web player: wizard + sign-in ----------------------------------------
  await page.getByRole("link", { name: "Open the web player" }).click();
  await page.waitForURL(`${BASE}/app/`);
  const wizard = page.getByRole("dialog");
  await wizard.getByRole("heading", { name: "Welcome to Cadence" }).waitFor({ timeout: 15_000 });
  await wizard.getByRole("button", { name: "Get started", exact: true }).click();
  await wizard.getByRole("heading", { name: "Connect your server" }).waitFor();
  await wizard.getByPlaceholder("Username").fill("webtester");
  await wizard.getByPlaceholder("Password").fill("web-test-password");
  await wizard.getByRole("button", { name: "Sign in", exact: true }).click();
  await wizard.getByText("Web Tester").waitFor({ timeout: 10_000 });
  await shot("3-wizard-signed-in");
  console.log("✓ signed in from the web player's setup wizard");
  while (await wizard.getByRole("button", { name: "Next", exact: true }).count()) {
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
  }
  await wizard.getByRole("button", { name: "Start listening", exact: true }).click();
  await page.locator(".wizard-backdrop").waitFor({ state: "detached" });

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

  const relevant = problems.filter((p) => !/favicon/i.test(p));
  assert.deepEqual(relevant, [], `the page reported problems:\n${relevant.join("\n")}`);
  console.log("Web player end-to-end test passed");
} finally {
  await browser.close();
}
