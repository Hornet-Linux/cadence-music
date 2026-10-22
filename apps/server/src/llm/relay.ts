import { randomBytes } from "node:crypto";
import type { LlmDeviceRegistration, LlmRelayJob, LlmRelayResult } from "@uma/shared";
import { LlmError, type LlmJsonRequest, type LlmProvider, type LlmStatus } from "./core/index.js";

const CHAT_TIMEOUT_MS = 190_000;
const STATUS_TIMEOUT_MS = 15_000;
/** Open device streams per person. A new connection from a known deviceId replaces its old one. */
export const MAX_DEVICES_PER_USER = 5;
/** Jobs waiting on one device, and on all of one person's devices. */
export const MAX_PENDING_PER_DEVICE = 4;
export const MAX_PENDING_PER_USER = 8;

interface Device {
  userId: number;
  registration: LlmDeviceRegistration;
  send: (job: LlmRelayJob) => void;
  close: () => void;
}

interface Pending {
  userId: number;
  deviceKey: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const keyOf = (userId: number, deviceId: string) => `${userId}:${deviceId}`;

/**
 * Lets a person's other devices use a provider that only one of their
 * computers can reach (Ollama on its loopback, say). The computer keeps a
 * stream open to the server; the server hands it jobs and the computer posts
 * the answers back. A device only ever serves jobs for its own owner, and its
 * API keys never leave it.
 */
export class RelayHub {
  private readonly devices = new Map<string, Device>();
  private readonly pending = new Map<string, Pending>();

  /** Whether `userId` may open a stream for `deviceId` (reconnecting an existing device always may). */
  canAttach(userId: number, deviceId: string): boolean {
    if (this.devices.has(keyOf(userId, deviceId))) return true;
    return this.devicesFor(userId).length < MAX_DEVICES_PER_USER;
  }

  /** Fail every job waiting on a device. */
  private failPending(deviceKey: string, message: string): void {
    for (const [jobId, p] of this.pending) {
      if (p.deviceKey === deviceKey) {
        clearTimeout(p.timer);
        this.pending.delete(jobId);
        p.reject(new LlmError(message));
      }
    }
  }

  /**
   * Attach a connected device. Replaces an older connection from the same
   * device. Returns null when the person already has too many devices open.
   */
  attach(userId: number, registration: LlmDeviceRegistration, send: Device["send"], close: Device["close"]): (() => void) | null {
    if (!this.canAttach(userId, registration.deviceId)) return null;
    const key = keyOf(userId, registration.deviceId);
    const older = this.devices.get(key);
    if (older) {
      this.devices.delete(key);
      this.failPending(key, "That device reconnected");
      try {
        older.close();
      } catch {
        // already closed
      }
    }
    const device: Device = { userId, registration, send, close };
    this.devices.set(key, device);
    return () => {
      // A newer connection may have replaced this one already.
      if (this.devices.get(key) !== device) return;
      this.devices.delete(key);
      this.failPending(key, "That device went offline");
    };
  }

  devicesFor(userId: number): LlmDeviceRegistration[] {
    return [...this.devices.values()].filter((d) => d.userId === userId).map((d) => d.registration);
  }

  /** Complete a job. Returns false if it doesn't exist or belongs to someone else. */
  complete(userId: number, jobId: string, result: LlmRelayResult): boolean {
    const p = this.pending.get(jobId);
    if (!p || p.userId !== userId) return false;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    if (result.ok) p.resolve(result.data);
    else p.reject(new LlmError(typeof result.error === "string" ? result.error.slice(0, 300) : "The device failed"));
    return true;
  }

  private dispatch(userId: number, deviceId: string, job: Omit<LlmRelayJob, "jobId">, timeoutMs: number): Promise<unknown> {
    const key = keyOf(userId, deviceId);
    const device = this.devices.get(key);
    if (!device) return Promise.reject(new LlmError("That device isn't online"));
    if (!device.registration.providers.some((p) => p.id === job.providerId)) {
      return Promise.reject(new LlmError("That device no longer offers this provider"));
    }
    let forDevice = 0;
    let forUser = 0;
    for (const p of this.pending.values()) {
      if (p.userId === userId) forUser++;
      if (p.deviceKey === key) forDevice++;
    }
    if (forDevice >= MAX_PENDING_PER_DEVICE || forUser >= MAX_PENDING_PER_USER) {
      return Promise.reject(new LlmError("That device is busy. Try again in a moment."));
    }
    const jobId = randomBytes(12).toString("base64url");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        reject(new LlmError("The device took too long to answer"));
      }, timeoutMs);
      this.pending.set(jobId, { userId, deviceKey: key, resolve, reject, timer });
      try {
        device.send({ ...job, jobId });
      } catch {
        clearTimeout(timer);
        this.pending.delete(jobId);
        reject(new LlmError("Couldn't reach that device"));
      }
    });
  }

  provider(userId: number, deviceId: string, providerId: string): LlmProvider {
    return {
      status: async () => (await this.dispatch(userId, deviceId, { providerId, op: "status" }, STATUS_TIMEOUT_MS)) as LlmStatus,
      chatJson: async <T>(req: LlmJsonRequest) =>
        (await this.dispatch(userId, deviceId, { providerId, op: "chat-json", request: req }, CHAT_TIMEOUT_MS)) as T,
    };
  }
}
