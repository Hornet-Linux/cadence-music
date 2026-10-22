import { useState } from "react";
import { primaryArtist } from "@/shared/types";
import { useServer } from "../../builtins/server/serverStore";
import "../_devices/devices.css";
import "./style.css";
import { RemotePlayer } from "./RemotePlayer";
import { saveDeviceName, selectOthers, useRemote } from "./remoteStore";
import type { RemoteDevice } from "./types";

const STATUS_TEXT: Record<string, string> = {
  off: "Off",
  connecting: "Connecting...",
  online: "Connected",
  reconnecting: "Connection lost, trying again...",
  "signed-out": "Sign in to your server to use remote control",
};

function summary(d: RemoteDevice): string {
  if (!d.online) return "Offline";
  const t = d.state?.track;
  if (!t) return "Idle";
  return `${d.state?.isPlaying ? "Playing" : "Paused"}: ${t.title} - ${primaryArtist(t)}`;
}

/** Other devices that show up with the same name get a short id so they can be told apart. */
export function labels(devices: RemoteDevice[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const d of devices) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  return new Map(devices.map((d) => [d.id, (counts.get(d.name) ?? 0) > 1 ? `${d.name} (${d.id.slice(-4)})` : d.name]));
}

export function RemotePage() {
  const { status, deviceName, deviceId, devices, selectedId, select } = useRemote();
  const user = useServer((s) => s.user);
  const [name, setName] = useState(deviceName);
  const others = selectOthers(devices, deviceId);
  const names = labels(devices);
  const selected = others.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="view rc-view">
      <header className="view-header">
        <h1>Remote control</h1>
        <p className="muted">Control another Cadence player signed in to your account, like your computer from your phone.</p>
      </header>

      <section className="card pad stack" aria-label="This device">
        <div className="rc-status" role="status">
          <span className={`status-dot ${status === "online" ? "online" : status === "reconnecting" ? "checking" : "offline"}`} aria-hidden />
          {STATUS_TEXT[status] ?? status}
        </div>
        <form
          className="dev-row"
          onSubmit={(e) => {
            e.preventDefault();
            saveDeviceName(name);
          }}
        >
          <label className="field-label" htmlFor="rc-name">
            Name of this device
          </label>
          <input id="rc-name" className="text-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <button className="btn" type="submit" disabled={!name.trim() || name.trim() === deviceName}>
            Save
          </button>
          <p className="muted small">The name takes effect the next time this player connects. Other devices see it in their list.</p>
        </form>
      </section>

      <h2 className="rc-h2">Your other players</h2>
      {!user && <p className="empty">Sign in to your server (Settings, Server) to see your other players.</p>}
      {user && others.length === 0 && (
        <p className="empty">No other player is open. Open Cadence on another device, signed in to the same account, with the Remote control plugin on.</p>
      )}
      <div className="rc-devices" role="listbox" aria-label="Other players">
        {others.map((d) => (
          <button
            key={d.id}
            role="option"
            aria-selected={d.id === selectedId}
            className={`rc-device${d.id === selectedId ? " selected" : ""}${d.online ? "" : " offline"}`}
            onClick={() => select(d.id === selectedId ? null : d.id)}
          >
            <span className="rc-dname">{names.get(d.id)}</span>
            <span className="rc-dsum">{summary(d)}</span>
          </button>
        ))}
      </div>

      {selected && <RemotePlayer device={selected} />}
    </div>
  );
}
