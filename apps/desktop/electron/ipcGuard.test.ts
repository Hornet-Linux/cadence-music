import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isAppUrl, isTrustedSender } from "./ipcGuard";

const rendererDir = path.resolve("/opt/cadence/dist");
const index = pathToFileURL(path.join(rendererDir, "index.html")).href;

describe("IPC sender check", () => {
  it("accepts only the app's own files or the dev server", () => {
    expect(isAppUrl(index, { rendererDir })).toBe(true);
    expect(isAppUrl(`${index}#/library`, { rendererDir })).toBe(true);
    expect(isAppUrl(pathToFileURL(path.resolve("/etc/passwd")).href, { rendererDir })).toBe(false);
    expect(isAppUrl(pathToFileURL(path.resolve("/opt/cadence/dist-evil/index.html")).href, { rendererDir })).toBe(false);
    expect(isAppUrl("https://evil.example/", { rendererDir })).toBe(false);
    expect(isAppUrl("http://localhost:5173/app", { rendererDir, devServerUrl: "http://localhost:5173/" })).toBe(true);
    expect(isAppUrl("http://localhost:5174/", { rendererDir, devServerUrl: "http://localhost:5173/" })).toBe(false);
  });

  it("refuses subframes and other windows", () => {
    const main = { url: index, parent: null, processId: 4, routingId: 1 };
    expect(isTrustedSender({ ...main }, main, { rendererDir })).toBe(true);
    expect(isTrustedSender({ ...main, parent: main, routingId: 7 }, main, { rendererDir })).toBe(false);
    expect(isTrustedSender({ ...main, processId: 9 }, main, { rendererDir })).toBe(false);
    expect(isTrustedSender({ ...main, url: "https://accounts.example/login" }, main, { rendererDir })).toBe(false);
    expect(isTrustedSender(null, main, { rendererDir })).toBe(false);
  });
});
