import { randomBytes } from "node:crypto";
import type { LlmDeviceRegistration, LlmRelayJob, LlmRelayResult } from "@uma/shared";
import { LlmError, type LlmJsonRequest, type LlmProvider, type LlmStatus } from "./core/index.js";

const CHAT_TIMEOUT_MS = 190_000;
const STATUS_TIMEOUT_MS = 15_000;

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

  /** Attach a connected device. Replaces an older connection from the same device. */
  attach(userId: number, registration: LlmDeviceRegistration, send: Device["send"], close: Device["close"]): () => void {
    const key = keyOf(userId, registration.deviceId);
    this.devices.get(key)?.close();
    const device: Device = { userId, registration, send, close };
    this.devices.set(key, device);
    return () => {
      // A newer connection may have replaced this one already.
      if (this.devices.get(key) !== device) return;
      this.devices.delete(key);
      for (const [jobId, p] of this.pending) {
        if (p.deviceKey === key) {
          clearTimeout(p.timer);
          this.pending.delete(jobId);
          p.reject(new LlmError("That device went offline"));
        }
      }
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
