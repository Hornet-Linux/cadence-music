import { useCallback, useEffect, useState } from "react";
import { useServer } from "../../builtins/server/serverStore";
import { friendlyError } from "../_devices/errors";
import "../_devices/devices.css";

interface HaConfig {
  url: string | null;
  entityId: string;
  hasToken: boolean;
  hasCommandToken: boolean;
  commandTokenCreatedAt: number | null;
  relayActive: boolean;
}

const api = <T,>(route: string, init?: RequestInit) => useServer.getState().api<T>(route, init);

export function HomeAssistantSettings() {
  const user = useServer((s) => s.user);
  const serverUrl = useServer((s) => s.url);
  const [cfg, setCfg] = useState<HaConfig | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [entity, setEntity] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  const apply = (c: HaConfig) => {
    setCfg(c);
    setUrl(c.url ?? "");
    setEntity(c.entityId);
  };

  const load = useCallback(async () => {
    try {
      apply(await api<HaConfig>("api/home-assistant/config"));
    } catch (err) {
      setMessage({ kind: "error", text: friendlyError(err, "Could not reach your server.") });
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (!user) return <p className="muted">Sign in to your server first (Settings, Server).</p>;

  const run = async (job: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await job();
      if (text) setMessage({ kind: "ok", text });
    } catch (err) {
      setMessage({ kind: "error", text: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const body = { url, entityId: entity, ...(token ? { token } : {}) };
      apply(await api<HaConfig>("api/home-assistant/config", { method: "PUT", body: JSON.stringify(body) }));
      setToken("");
      return "Saved.";
    });
  const test = () => run(async () => (await api<{ message: string }>("api/home-assistant/test", { method: "POST" })).message);
  const remove = () =>
    run(async () => {
      apply(await api<HaConfig>("api/home-assistant/config", { method: "DELETE" }));
      return "Removed.";
    });
  const makeToken = () =>
    run(async () => {
      setNewToken((await api<{ token: string }>("api/home-assistant/command-token", { method: "POST" })).token);
      await load();
    });
  const revoke = () =>
    run(async () => {
      await api("api/home-assistant/command-token", { method: "DELETE" });
      setNewToken(null);
      await load();
      return "Command token removed.";
    });

  return (
    <div className="stack dev-panel">
      {cfg && !cfg.relayActive && (
        <p className="notice warn">
          The Remote control server plugin is off. Cadence needs it to know what is playing and to reach your players, so turn it on in the admin settings.
        </p>
      )}
      {message && (
        <p className={`notice ${message.kind === "error" ? "error" : ""}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}

      <h3 className="dev-h">Send now-playing to Home Assistant</h3>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field-label" htmlFor="ha-url">
          Home Assistant address
        </label>
        <input id="ha-url" className="text-input" placeholder="http://homeassistant.local:8123" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoCapitalize="off" />
        <label className="field-label" htmlFor="ha-token">
          Long-lived access token {cfg?.hasToken && <span className="muted">(saved; leave empty to keep it)</span>}
        </label>
        <input
          id="ha-token"
          className="text-input"
          type="password"
          autoComplete="off"
          placeholder={cfg?.hasToken ? "Saved" : "Paste a token from your Home Assistant profile"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <label className="field-label" htmlFor="ha-entity">
          Entity to update
        </label>
        <input id="ha-entity" className="text-input" value={entity} onChange={(e) => setEntity(e.target.value)} spellCheck={false} autoCapitalize="off" />
        <div className="dev-actions">
          <button className="btn primary" type="submit" disabled={busy}>
            Save
          </button>
          <button className="btn" type="button" disabled={busy || !cfg?.url || !cfg.hasToken} onClick={() => void test()}>
            Test connection
          </button>
          {(cfg?.url || cfg?.hasToken) && (
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void remove()}>
              Remove
            </button>
          )}
        </div>
        <p className="muted small">Your server calls Home Assistant (POST /api/states/{entity || "..."}). The token is stored encrypted on your server.</p>
      </form>

      <h3 className="dev-h">Let Home Assistant control Cadence</h3>
      <p className="muted small">
        Create a command token, then use it in a rest_command in Home Assistant. Commands go to the player you are listening on. See docs/HOME_ASSISTANT.md for ready-to-paste YAML.
      </p>
      <div className="dev-actions">
        <button className="btn" disabled={busy} onClick={() => void makeToken()}>
          {cfg?.hasCommandToken ? "Make a new command token" : "Create command token"}
        </button>
        {cfg?.hasCommandToken && (
          <button className="btn ghost" disabled={busy} onClick={() => void revoke()}>
            Revoke
          </button>
        )}
      </div>
      {newToken && (
        <div className="notice" role="status">
          <p>Copy this now. It is shown only once.</p>
          <code className="selectable dev-token">{newToken}</code>
          <p className="muted small">
            Endpoint: <code className="selectable">{serverUrl}/api/home-assistant/command</code>
          </p>
        </div>
      )}
      {cfg?.hasCommandToken && !newToken && <p className="muted small">A command token exists. It cannot be shown again; make a new one if you lost it.</p>}
    </div>
  );
}
