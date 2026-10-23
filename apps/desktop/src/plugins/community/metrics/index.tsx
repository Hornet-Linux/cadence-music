import { useState } from "react";
import type { Plugin } from "../../types";
import { SlidersIcon } from "@/ui/icons";
import { CopyButton, NeedAdmin, Notice, useAction, useLoad, useOps } from "../_ops/ui";
import "./style.css";

interface Config {
  tokenSet: boolean;
  tokenFromEnvironment: boolean;
  path: string;
}

function Panel() {
  const { api, url } = useOps();
  const config = useLoad(() => api<Config>("api/metrics/config"));
  const { busy, error, run } = useAction();
  const [token, setToken] = useState<string | null>(null);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "your-server";
    }
  })();
  const scheme = url.startsWith("https") ? "https" : "http";

  const make = async () => {
    if (config.data?.tokenSet && !window.confirm("Make a new token? The current one stops working.")) return;
    const res = await run(() => api<{ token: string }>("api/metrics/token", { method: "POST" }));
    if (res) {
      setToken(res.token);
      config.reload();
    }
  };
  const remove = async () => {
    if (!window.confirm("Remove the token? Prometheus can no longer scrape until you make a new one.")) return;
    await run(() => api<void>("api/metrics/token", { method: "DELETE" }));
    setToken(null);
    config.reload();
  };

  const yaml = `scrape_configs:
  - job_name: cadence
    scheme: ${scheme}
    metrics_path: /metrics
    authorization:
      credentials: ${token ?? "<your token>"}
    static_configs:
      - targets: ["${host}"]`;

  return (
    <div className="ops-panel">
      <p className="muted small">
        The server publishes <code>/metrics</code> in the Prometheus text format: requests and latency per route, sessions, library size, background jobs, errors and process statistics. It needs a token (or an admin sign-in).
      </p>
      {config.error && <Notice tone="error">{config.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {config.data && (
        <p>
          Token: <span className={`ops-pill ${config.data.tokenSet ? "ok" : "warn"}`}>{config.data.tokenSet ? (config.data.tokenFromEnvironment ? "set by METRICS_TOKEN" : "set") : "not set"}</span>
        </p>
      )}
      {token && (
        <Notice tone="ok">
          <strong>Your new token.</strong> It is shown only now.
          <pre>{token}</pre>
          <CopyButton text={token} />
        </Notice>
      )}
      <div className="ops-actions">
        <button className="btn primary" disabled={busy || Boolean(config.data?.tokenFromEnvironment)} onClick={() => void make()}>
          {config.data?.tokenSet ? "Make a new token" : "Make a token"}
        </button>
        {config.data?.tokenSet && !config.data.tokenFromEnvironment && (
          <button className="btn ghost" disabled={busy} onClick={() => void remove()}>Remove token</button>
        )}
      </div>
      <details>
        <summary>Prometheus configuration</summary>
        <pre>{yaml}</pre>
        <CopyButton text={yaml} label="Copy configuration" />
      </details>
    </div>
  );
}

const plugin: Plugin = {
  manifest: {
    id: "cadence.metrics",
    name: "Prometheus metrics",
    version: "1.0.0",
    description: "Admin tool: make a scrape token for the server's /metrics endpoint.",
    author: "Cadence",
    capabilities: ["ui.settings"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "metrics",
      title: "Metrics",
      description: "Prometheus scrape token for the server.",
      icon: <SlidersIcon size={19} />,
      keywords: ["prometheus", "grafana", "monitoring", "scrape"],
      render: () => (
        <NeedAdmin>
          <Panel />
        </NeedAdmin>
      ),
    });
  },
};

export default plugin;