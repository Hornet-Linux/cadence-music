import { useCallback, useEffect, useRef, useState } from "react";
import { MuteIcon, VolumeIcon } from "@/ui/icons";
import { useServer } from "../../builtins/server/serverStore";
import { friendlyError } from "../_devices/errors";
import "../_devices/devices.css";
import "./style.css";
import { snapApi, type SnapClient, type SnapGroup, type SnapStatus } from "./snapApi";

function ClientRow({ client, onChange }: { client: SnapClient; onChange: () => void }) {
  const [volume, setVolume] = useState(client.volume);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setVolume(client.volume), [client.volume]);
  return (
    <li className={`sc-client${client.connected ? "" : " offline"}`}>
      <div className="sc-cname">
        {client.name}
        {!client.connected && <span className="sc-off"> (offline)</span>}
      </div>
      <div className="sc-ctrl">
        <button
          className="icon-btn sc-btn"
          aria-label={client.muted ? `Unmute ${client.name}` : `Mute ${client.name}`}
          aria-pressed={client.muted}
          onClick={() => void snapApi.setClientMuted(client.id, !client.muted).then(onChange, onChange)}
        >
          {client.muted ? <MuteIcon size={18} /> : <VolumeIcon size={18} />}
        </button>
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label={`${client.name} volume`}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => void snapApi.setClientVolume(client.id, v).then(onChange, onChange), 200);
          }}
        />
        <span className="sc-pct">{volume}</span>
      </div>
    </li>
  );
}

function GroupCard({ group, streams, onChange }: { group: SnapGroup; streams: SnapStatus["streams"]; onChange: () => void }) {
  return (
    <section className="card pad sc-group" aria-label={group.name || "Group"}>
      <div className="sc-ghead">
        <h2>{group.name || group.clients.map((c) => c.name).join(", ") || "Empty group"}</h2>
        <button
          className="btn"
          aria-pressed={group.muted}
          onClick={() => void snapApi.setGroupMuted(group.id, !group.muted).then(onChange, onChange)}
        >
          {group.muted ? "Unmute group" : "Mute group"}
        </button>
      </div>
      <label className="sc-stream">
        <span className="field-label">Stream</span>
        <select
          className="text-input"
          value={group.streamId}
          onChange={(e) => void snapApi.setGroupStream(group.id, e.target.value).then(onChange, onChange)}
        >
          {streams.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id} ({s.status})
            </option>
          ))}
          {!streams.some((s) => s.id === group.streamId) && <option value={group.streamId}>{group.streamId || "none"}</option>}
        </select>
      </label>
      <ul className="sc-clients">
        {group.clients.map((c) => (
          <ClientRow key={c.id} client={c} onChange={onChange} />
        ))}
      </ul>
    </section>
  );
}

export function SnapcastPage() {
  const user = useServer((s) => s.user);
  const [status, setStatus] = useState<SnapStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await snapApi.status());
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "Could not reach the Snapcast server."));
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void load();
    snapApi.getConfig().then((c) => setAddress(c.address ?? ""), () => undefined);
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [user, load]);

  return (
    <div className="view sc-view">
      <header className="view-header">
        <h1>Snapcast</h1>
        <p className="muted">
          Volume, mute and stream choice for rooms on your Snapcast server. Cadence does not send music into Snapcast; point a Snapcast
          stream at the music source you want.
        </p>
      </header>

      {!user && <p className="empty">Sign in to your server (Settings, Server) first.</p>}

      {user?.isAdmin && (
        <form
          className="dev-row"
          onSubmit={(e) => {
            e.preventDefault();
            setSaving(true);
            snapApi
              .setConfig(address.trim() || null)
              .then(() => load())
              .catch((err) => setError(friendlyError(err)))
              .finally(() => setSaving(false));
          }}
        >
          <label className="field-label" htmlFor="sc-addr">
            Snapcast server address
          </label>
          <input id="sc-addr" className="text-input" placeholder="192.168.1.5 or 192.168.1.5:1705" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoCapitalize="off" />
          <button className="btn primary" type="submit" disabled={saving}>
            Save
          </button>
          <p className="muted small">Uses the JSON-RPC control port (1705 by default). An http:// address uses the HTTP control port (1780).</p>
        </form>
      )}

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {user && status && !status.configured && <p className="empty">{user.isAdmin ? "Enter your Snapcast server address above." : "Ask a server admin to set up the Snapcast address."}</p>}
      {status?.configured && status.groups.length === 0 && !error && <p className="empty">The Snapcast server has no groups.</p>}
      {status?.groups.map((g) => (
        <GroupCard key={g.id} group={g} streams={status.streams} onChange={() => void load()} />
      ))}
      {status?.serverVersion && <p className="muted small">Snapcast server {status.serverVersion}</p>}
    </div>
  );
}
