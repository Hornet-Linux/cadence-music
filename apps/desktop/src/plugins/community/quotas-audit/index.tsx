import { useState } from "react";
import type { Plugin } from "../../types";
import { ClockIcon } from "@/ui/icons";
import { Check, Field, NeedAdmin, Notice, formatHours, formatWhen, useAction, useLoad, useOps } from "../_ops/ui";
import "./style.css";

interface Config {
  maxConcurrentStreams: number;
  maxHoursPerDay: number;
  exemptAdmins: boolean;
  overrides: Record<string, { maxConcurrentStreams?: number; maxHoursPerDay?: number }>;
}

interface UsageItem {
  userId: number;
  username: string;
  isAdmin: boolean;
  todaySeconds: number;
  last7Seconds: number;
  last30Seconds: number;
  streams30: number;
  lastStreamAt: number | null;
  activeStreams: number;
  limits: { maxConcurrentStreams: number; maxHoursPerDay: number } | null;
}

interface Usage {
  config: Config;
  items: UsageItem[];
  denied: { concurrent: number; daily: number };
}

function Panel() {
  const { api } = useOps();
  const usage = useLoad(() => api<Usage>("api/quotas/usage"));
  const events = useLoad(() => api<{ items: { id: number; username: string | null; at: number; kind: string }[] }>("api/quotas/events?limit=15"));
  const { busy, error, run } = useAction();
  const [draft, setDraft] = useState<Config | null>(null);
  const [saved, setSaved] = useState(false);
  const config = draft ?? usage.data?.config ?? null;

  const save = async () => {
    if (!config) return;
    const res = await run(() => api<{ config: Config }>("api/quotas/config", { method: "PUT", body: JSON.stringify(config) }));
    if (res) {
      setDraft(res.config);
      setSaved(true);
      usage.reload();
    }
  };
  const refresh = () => {
    usage.reload();
    events.reload();
  };

  return (
    <div className="ops-panel">
      <p className="muted small">
        Limits apply to streaming from the server library. Counting starts when a track starts, in UTC days. A device is a browser or app on one address; skipping tracks does not make a new stream. Jellyfin streams are not limited.
      </p>
      {usage.error && <Notice tone="error">{usage.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice tone="ok">Saved. New limits apply to the next track anyone starts.</Notice>}
      {config && (
        <>
          <div className="ops-grid">
            <Field label="Devices streaming at once" hint="0 means no limit." htmlFor="q-conc">
              <input id="q-conc" type="number" min={0} max={100} value={config.maxConcurrentStreams} onChange={(e) => { setSaved(false); setDraft({ ...config, maxConcurrentStreams: Number(e.target.value) }); }} />
            </Field>
            <Field label="Hours of music per person per day" hint="0 means no limit." htmlFor="q-hours">
              <input id="q-hours" type="number" min={0} max={24} step={0.5} value={config.maxHoursPerDay} onChange={(e) => { setSaved(false); setDraft({ ...config, maxHoursPerDay: Number(e.target.value) }); }} />
            </Field>
          </div>
          <Check checked={config.exemptAdmins} onChange={(exemptAdmins) => { setSaved(false); setDraft({ ...config, exemptAdmins }); }}>
            Do not limit admins
          </Check>
          <div>
            <button className="btn primary" disabled={busy} onClick={() => void save()}>Save limits</button>
          </div>
        </>
      )}

      <div className="ops-section-head">
        <h3 className="q-sub">Usage per person</h3>
        <button className="btn ghost" onClick={refresh}>Refresh</button>
      </div>
      {usage.data && (
        <>
          <table className="ops-table">
            <thead>
              <tr><th>Person</th><th>Today</th><th>7 days</th><th>30 days</th><th>Streams (30 d)</th><th>Now</th><th>Last stream</th></tr>
            </thead>
            <tbody>
              {usage.data.items.map((u) => (
                <tr key={u.userId}>
                  <td data-label="Person">{u.username}{u.isAdmin ? " (admin)" : ""}</td>
                  <td data-label="Today">{formatHours(u.todaySeconds)}</td>
                  <td data-label="7 days">{formatHours(u.last7Seconds)}</td>
                  <td data-label="30 days">{formatHours(u.last30Seconds)}</td>
                  <td data-label="Streams (30 d)">{u.streams30}</td>
                  <td data-label="Now">{u.activeStreams}</td>
                  <td data-label="Last stream">{formatWhen(u.lastStreamAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Refused so far since the server started: {usage.data.denied.concurrent} for too many devices, {usage.data.denied.daily} for the daily limit.</p>
        </>
      )}
      <h3 className="q-sub">Recent activity</h3>
      <div className="ops-list">
        {events.data?.items.length === 0 && <p className="muted">No streams recorded yet.</p>}
        {events.data?.items.map((e) => (
          <div className="ops-item" key={e.id}>
            <div className="ops-item-text">
              <div className="ops-item-title">{e.username ?? "Someone"} - {e.kind === "stream" ? "started a stream" : `refused (${e.kind.replace("denied:", "")})`}</div>
              <div className="ops-item-sub">{formatWhen(e.at)}</div>
            </div>
            {e.kind !== "stream" && <span className="ops-pill bad">refused</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

const plugin: Plugin = {
  manifest: {
    id: "cadence.quotas-audit",
    name: "Quotas and usage",
    version: "1.0.0",
    description: "Admin tool: limit devices and hours per person on the server's streaming and see who streamed what.",
    author: "Cadence",
    capabilities: ["ui.settings"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "quotas-audit",
      title: "Quotas and usage",
      description: "Limit streaming per person and see who listens.",
      icon: <ClockIcon size={19} />,
      keywords: ["limit", "quota", "concurrent", "usage", "hours", "streams"],
      render: () => (
        <NeedAdmin>
          <Panel />
        </NeedAdmin>
      ),
    });
  },
};

export default plugin;