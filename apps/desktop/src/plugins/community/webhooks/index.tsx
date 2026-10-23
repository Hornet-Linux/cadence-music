import { useState } from "react";
import type { Plugin } from "../../types";
import { PlugIcon } from "@/ui/icons";
import { Check, CopyButton, Field, NeedAdmin, Notice, formatWhen, useAction, useLoad, useOps } from "../_ops/ui";
import "./style.css";

interface Endpoint {
  id: string;
  name: string;
  url: string;
  events: string[];
  template: string;
  enabled: boolean;
  allowPrivate: boolean;
  secretSet: boolean;
}

interface Overview {
  endpoints: Endpoint[];
  events: string[];
  templates: { id: string; label: string }[];
  counts: { pending: number; failed: number; success: number };
  signing: { scheme: string };
}

interface Delivery {
  id: string;
  endpointName: string;
  event: string;
  status: "pending" | "success" | "failed";
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: number;
  nextAttemptAt: number | null;
}

const VERIFY_SNIPPET = `// Node.js receiver: verify before trusting a delivery
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, headers, rawBody) {
  const ts = headers["x-cadence-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(ts + "." + rawBody).digest("hex");
  const given = headers["x-cadence-signature"] ?? "";
  return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}`;

function AddEndpoint({ overview, onDone }: { overview: Overview; onDone: (secret: string, name: string) => void }) {
  const { api } = useOps();
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [template, setTemplate] = useState("generic");
  const [events, setEvents] = useState<string[]>(overview.events);
  const [allowPrivate, setAllowPrivate] = useState(false);

  const save = async () => {
    const res = await run(() => api<{ secret: string }>("api/webhooks/endpoints", { method: "POST", body: JSON.stringify({ name, url, template, events, allowPrivate }) }));
    if (res) {
      onDone(res.secret, name);
      setName("");
      setUrl("");
      setAllowPrivate(false);
    }
  };

  return (
    <div className="ops-panel wh-form">
      <h3 className="wh-sub">Add an endpoint</h3>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="ops-grid">
        <Field label="Name" htmlFor="wh-name">
          <input id="wh-name" type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Home Assistant" />
        </Field>
        <Field label="Destination URL" htmlFor="wh-url">
          <input id="wh-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/cadence" />
        </Field>
        <Field label="Payload" htmlFor="wh-template">
          <select id="wh-template" value={template} onChange={(e) => setTemplate(e.target.value)}>
            {overview.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div>
        <span className="field-label">Send these events</span>
        {overview.events.map((ev) => (
          <Check key={ev} checked={events.includes(ev)} onChange={(on) => setEvents(on ? [...events, ev] : events.filter((e) => e !== ev))}>
            <code>{ev}</code>
          </Check>
        ))}
      </div>
      <Check checked={allowPrivate} onChange={setAllowPrivate}>
        Allow this endpoint on my private network (LAN, localhost)
      </Check>
      {allowPrivate && <Notice tone="warn">Only turn this on for services you run yourself. It lets the server send requests to machines inside your network.</Notice>}
      <div>
        <button className="btn primary" disabled={busy || !name.trim() || !url.trim() || events.length === 0} onClick={() => void save()}>
          Add endpoint
        </button>
      </div>
    </div>
  );
}

function Panel() {
  const { api } = useOps();
  const overview = useLoad(() => api<Overview>("api/webhooks"));
  const deliveries = useLoad(() => api<{ items: Delivery[] }>("api/webhooks/deliveries?limit=30"));
  const { busy, error, run } = useAction();
  const [fresh, setFresh] = useState<{ secret: string; name: string } | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const reloadAll = () => {
    overview.reload();
    deliveries.reload();
  };
  const test = async (e: Endpoint) => {
    setTestResult(null);
    const res = await run(() => api<{ delivery: Delivery | null }>(`api/webhooks/endpoints/${e.id}/test`, { method: "POST" }));
    if (res?.delivery) setTestResult(res.delivery.status === "success" ? `${e.name}: the test arrived.` : `${e.name}: ${res.delivery.lastError ?? "the test failed"}`);
    reloadAll();
  };
  const toggle = async (e: Endpoint) => {
    await run(() => api(`api/webhooks/endpoints/${e.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !e.enabled }) }));
    reloadAll();
  };
  const rotate = async (e: Endpoint) => {
    if (!window.confirm(`Make a new signing secret for ${e.name}? The old one stops working.`)) return;
    const res = await run(() => api<{ secret: string }>(`api/webhooks/endpoints/${e.id}`, { method: "PATCH", body: JSON.stringify({ rotateSecret: true }) }));
    if (res) setFresh({ secret: res.secret, name: e.name });
  };
  const remove = async (e: Endpoint) => {
    if (!window.confirm(`Delete the endpoint ${e.name}?`)) return;
    await run(() => api<void>(`api/webhooks/endpoints/${e.id}`, { method: "DELETE" }));
    reloadAll();
  };
  const retry = async (d: Delivery) => {
    await run(() => api(`api/webhooks/deliveries/${d.id}/retry`, { method: "POST" }));
    setTimeout(reloadAll, 800);
  };

  return (
    <div className="ops-panel">
      {overview.error && <Notice tone="error">{overview.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {testResult && <Notice tone={testResult.includes("arrived") ? "ok" : "error"}>{testResult}</Notice>}
      {fresh && (
        <Notice tone="ok">
          <strong>Signing secret for {fresh.name}.</strong> It is shown only now; save it in the receiving service.
          <pre>{fresh.secret}</pre>
          <div className="ops-actions">
            <CopyButton text={fresh.secret} />
            <button className="btn ghost" onClick={() => setFresh(null)}>
              I saved it
            </button>
          </div>
        </Notice>
      )}

      {overview.data && (
        <>
          <div className="ops-list">
            {overview.data.endpoints.length === 0 && <p className="muted">No endpoints yet. Add one below to start sending events.</p>}
            {overview.data.endpoints.map((e) => (
              <div className="ops-item" key={e.id}>
                <div className="ops-item-text">
                  <div className="ops-item-title">
                    {e.name} <span className={`ops-pill ${e.enabled ? "ok" : ""}`}>{e.enabled ? "on" : "off"}</span>
                  </div>
                  <div className="ops-item-sub">{e.url}</div>
                  <div className="ops-item-sub">
                    {e.template} - {e.events.join(", ")}
                    {e.allowPrivate ? " - private network allowed" : ""}
                  </div>
                </div>
                <div className="ops-item-buttons">
                  <button className="btn" disabled={busy} onClick={() => void test(e)}>Send test</button>
                  <button className="btn ghost" disabled={busy} onClick={() => void toggle(e)}>{e.enabled ? "Turn off" : "Turn on"}</button>
                  <button className="btn ghost" disabled={busy} onClick={() => void rotate(e)}>New secret</button>
                  <button className="btn ghost" disabled={busy} onClick={() => void remove(e)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
          <AddEndpoint overview={overview.data} onDone={(secret, name) => { setFresh({ secret, name }); reloadAll(); }} />
        </>
      )}

      <div className="ops-section-head">
        <h3 className="wh-sub">Delivery log</h3>
        <button className="btn ghost" onClick={reloadAll}>Refresh</button>
      </div>
      {overview.data && (
        <p className="muted small">
          {overview.data.counts.success} delivered, {overview.data.counts.pending} waiting to retry, {overview.data.counts.failed} failed. Failed deliveries are tried again after 10 s, 1 min, 5 min, 30 min and 2 h.
        </p>
      )}
      <div className="ops-list">
        {deliveries.data?.items.length === 0 && <p className="muted">Nothing has been sent yet.</p>}
        {deliveries.data?.items.map((d) => (
          <div className="ops-item" key={d.id}>
            <div className="ops-item-text">
              <div className="ops-item-title">
                {d.event} to {d.endpointName}{" "}
                <span className={`ops-pill ${d.status === "success" ? "ok" : d.status === "failed" ? "bad" : "warn"}`}>{d.status}</span>
              </div>
              <div className="ops-item-sub">
                {formatWhen(d.createdAt)} - {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                {d.lastStatus ? ` - HTTP ${d.lastStatus}` : ""}
                {d.lastError && d.status !== "success" ? ` - ${d.lastError}` : ""}
              </div>
            </div>
            {d.status === "failed" && (
              <button className="btn" disabled={busy} onClick={() => void retry(d)}>Retry</button>
            )}
          </div>
        ))}
      </div>

      <details>
        <summary>How receivers check the signature</summary>
        <p className="muted small">{overview.data?.signing.scheme}</p>
        <pre>{VERIFY_SNIPPET}</pre>
      </details>
    </div>
  );
}

const plugin: Plugin = {
  manifest: {
    id: "cadence.webhooks",
    name: "Webhooks",
    version: "1.0.0",
    description: "Admin tool: send signed webhooks to n8n, Home Assistant, Discord or your own service when plays are recorded or the library changes.",
    author: "Cadence",
    capabilities: ["ui.settings"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "webhooks",
      title: "Webhooks",
      description: "Tell other services when music is played or the library changes.",
      icon: <PlugIcon size={19} />,
      keywords: ["n8n", "home assistant", "discord", "automation", "hmac", "events"],
      render: () => (
        <NeedAdmin>
          <Panel />
        </NeedAdmin>
      ),
    });
  },
};

export default plugin;