import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

// Secrets are encrypted with the OS keychain (DPAPI on Windows) via
// safeStorage and kept in a small JSON file in the user-data folder.

export const SECRET_KEY_RE = /^[\w.:-]{1,100}$/;
const secretsFile = () => path.join(app.getPath("userData"), "secrets.json");

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(secretsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, string>) {
  fs.writeFileSync(secretsFile(), JSON.stringify(all), { mode: 0o600 });
}

export function getSecret(key: string): string | null {
  if (!SECRET_KEY_RE.test(key)) return null;
  const encrypted = readAll()[key];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return null;
  }
}

export function setSecret(key: string, value: string): void {
  if (!SECRET_KEY_RE.test(key)) throw new Error("Invalid secret key");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage is unavailable");
  const all = readAll();
  all[key] = safeStorage.encryptString(value).toString("base64");
  writeAll(all);
}

export function deleteSecret(key: string): void {
  if (!SECRET_KEY_RE.test(key)) return;
  const all = readAll();
  if (!(key in all)) return;
  delete all[key];
  writeAll(all);
}
