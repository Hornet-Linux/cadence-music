// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { featuresFor, parseConfig, readConfig, writeConfig } from "./integrationsConfig";

describe("integrations config", () => {
  it("defaults everything to off and ignores junk", () => {
    expect(parseConfig(null)).toEqual({ systemMediaControls: false });
    expect(parseConfig({ systemMediaControls: "yes" })).toEqual({ systemMediaControls: false });
  });
  it("enables Chromium's media features only when asked", () => {
    expect(featuresFor({ systemMediaControls: false })).toEqual([]);
    expect(featuresFor({ systemMediaControls: true })).toEqual(["HardwareMediaKeyHandling", "MediaSessionService"]);
  });
  it("round-trips through the user-data folder and survives a missing or broken file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadence-int-"));
    expect(readConfig(dir).systemMediaControls).toBe(false);
    writeConfig(dir, { systemMediaControls: true });
    expect(readConfig(dir).systemMediaControls).toBe(true);
    fs.writeFileSync(path.join(dir, "integrations.json"), "{broken");
    expect(readConfig(dir).systemMediaControls).toBe(false);
  });
});