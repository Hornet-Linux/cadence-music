import type { LlmDeviceRegistration, LlmRelayJob, LlmRelayResult } from "@uma/shared";
import { apiUrl, useServer } from "@/plugins/builtins/server/serverStore";
import type { HostBridge } from "../../../electron/preload";
import { deviceId, localConfig, useProviders, type LocalProvider } from "./providers";

// Offers this device's shared providers (Ollama on localhost, a key typed here)
// to the person's other devices. The app keeps a request open to the server;
// the server sends jobs down it and this device runs them against the local
// provider and posts the answers back. Keys and URLs never leave this device.

const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

export function deviceName(): string {
  switch (window.host?.platform as string | undefined) {
    case "win32":
      return "Windows PC";
    case "darwin":
      return "Mac";
    case "linux":
      return "Linux PC";
    default:
      return "Web browser";
  }
}

/** What to tell the server about this device, or null when nothing is shared. */
export function buildRegistration(local: LocalProvider[]): LlmDeviceRegistration | null {
  const shared = local.filter((p) => p.share);
  if (!shared.length) return null;
  return {
    deviceId: deviceId(),
    name: deviceName(),
    providers: shared.map((p) => ({ id: p.id, name: p.name, kind: p.kind, model: p.model })),
  };
}

/** Split a server-sent event stream into complete events and the unfinished tail. */
export function parseEvents(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  const events = parts
    .map((block) => {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      return { event, data: data.join("\n") };
    })
    .filter((e) => e.data || e.event !== "message");
  return { events, rest };
}

/** Run one job against the matching local provider. */
export async function runJob(job: LlmRelayJob, local: LocalProvider[], llm: HostBridge["llm"] | undefined): Promise<LlmRelayResult> {
  const provider = local.find((p) => p.id === job.providerId && p.share);
  if (!provider) return { ok: false, error: "That provider isn't shared from this device any more" };
  if (!llm) return { ok: false, error: "This device can't run AI requests" };
  try {
    const config = await localConfig(provider);
    if (job.op === "status") return { ok: true, data: await llm.status(config) };
    if (!job.request) return { ok: false, error: "The request was empty" };
    return { ok: true, data: await llm.chatJson(config, job.request) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

async function answer(jobId: string, result: LlmRelayResult): Promise<void> {
  const { url, token } = useServer.getState();
  await fetch(apiUrl(url, `api/llm/devices/jobs/${jobId}`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(result),
  }).catch(() => undefined);
}

async function connectLoop(registration: LlmDeviceRegistration, signal: AbortSignal): Promise<void> {
  let delay = FIRST_RETRY_MS;
  while (!signal.aborted) {
    try {
      const { url, token } = useServer.getState();
      const res = await fetch(apiUrl(url, "api/llm/devices/connect"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(registration),
        signal,
      });
      // Signed out, or a server too old to have the relay: nothing to retry.
      if (res.status === 401 || res.status === 403 || res.status === 404) return;
      if (!res.ok || !res.body) throw new Error(`Relay returned ${res.status}`);
      delay = FIRST_RETRY_MS;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseEvents(buffer);
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.event !== "job") continue;
          try {
            const job = JSON.parse(ev.data) as LlmRelayJob;
            void runJob(job, useProviders.getState().local, window.host?.llm).then((r) => answer(job.jobId, r));
          } catch {
            // A malformed job can't be answered; ignore it.
          }
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    await sleep(delay, signal);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
}

/** Keep the relay connected while signed in to a server and something is shared. */
export function startRelay(): () => void {
  let controller: AbortController | null = null;
  let activeKey = "";

  function sync() {
    const { user, url, token } = useServer.getState();
    const registration = user && token ? buildRegistration(useProviders.getState().local) : null;
    const key = registration ? JSON.stringify([url, token, registration]) : "";
    if (key === activeKey) return;
    controller?.abort();
    controller = null;
    activeKey = key;
    if (!registration) return;
    controller = new AbortController();
    void connectLoop(registration, controller.signal);
  }

  const offServer = useServer.subscribe(sync);
  const offProviders = useProviders.subscribe(sync);
  sync();
  return () => {
    offServer();
    offProviders();
    controller?.abort();
  };
}
