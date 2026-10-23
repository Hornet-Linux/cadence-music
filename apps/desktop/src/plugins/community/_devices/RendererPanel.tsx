import { useCallback, useEffect, useState } from "react";
import { useServer } from "../../builtins/server/serverStore";
import { rendererApi, type DeviceInfo, type DeviceList } from "./deviceApi";
import { friendlyError } from "./errors";
import "./devices.css";

export interface RendererPanelProps {
  prefix: "dlna" | "chromecast";
  /** "speakers and TVs", "Chromecasts"... */
  noun: string;
  /** Example of what to type in the address box. */
  addressExample: string;
  /** Extra help shown under the list. */
  note?: string;
}

const KIND_LABEL: Record<string, string> = { sonos: "Sonos", upnp: "DLNA / UPnP", chromecast: "Chromecast" };

/** Settings panel for a network-device plugin: what the server found, add one by address, and the stream address. */
export function RendererPanel({ prefix, noun, addressExample, note }: RendererPanelProps) {
  const user = useServer((s) => s.user);
  const [list, setList] = useState<DeviceList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [base, setBase] = useState("");
  const [baseSaved, setBaseSaved] = useState<string | null>(null);
  const api = rendererApi(prefix);

  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      setError(null);
      try {
        setList(await rendererApi(prefix).list(refresh));
      } catch (err) {
        setError(friendlyError(err, "Could not reach the server."));
      } finally {
        setBusy(false);
      }
    },
    [prefix],
  );

  useEffect(() => {
    if (!user) return;
    void load(false);
    rendererApi(prefix)
      .getConfig()
      .then((c) => {
        setBase(c.streamBaseUrl ?? "");
        setBaseSaved(c.streamBaseUrl);
      })
      .catch(() => undefined);
  }, [user, prefix, load]);

  if (!user) return <p className="muted">Sign in to your server first (Settings, Server).</p>;

  const act = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      await load(false);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack dev-panel">
      <div className="dev-head">
        <p className="muted small">{list?.devices.length ? `${list.devices.length} found by your server.` : `No ${noun} found yet.`}</p>
        <button className="btn" onClick={() => void load(true)} disabled={busy}>
          {busy ? "Looking..." : "Look again"}
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <ul className="dev-list" aria-label={`Found ${noun}`}>
        {list?.devices.map((d: DeviceInfo) => (
          <li key={d.id} className="dev-item">
            <span className="dev-name">{d.name}</span>
            <span className="dev-meta">
              {KIND_LABEL[d.kind] ?? d.kind}
              {d.model ? `, ${d.model}` : ""}
              {d.address ? ` - ${d.address}` : ""}
              {d.manual ? " - added by hand" : ""}
            </span>
            {d.manual && user.isAdmin && (
              <button className="btn ghost" onClick={() => void act(() => api.removeManual(d.id))} aria-label={`Remove ${d.name}`}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {list?.hint && <p className="muted small">{list.hint}</p>}
      {note && <p className="muted small">{note}</p>}
      {user.isAdmin ? (
        <>
          <form
            className="dev-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (address.trim()) void act(async () => (await api.addManual(address.trim()), setAddress("")));
            }}
          >
            <label className="field-label" htmlFor={`${prefix}-addr`}>
              Add by address
            </label>
            <input
              id={`${prefix}-addr`}
              className="text-input"
              placeholder={addressExample}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
            <button className="btn primary" type="submit" disabled={busy || !address.trim()}>
              Add
            </button>
          </form>
          <form
            className="dev-row"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => setBaseSaved((await api.setConfig(base.trim() || null)).streamBaseUrl));
            }}
          >
            <label className="field-label" htmlFor={`${prefix}-base`}>
              Server address for devices (optional)
            </label>
            <input
              id={`${prefix}-base`}
              className="text-input"
              placeholder="http://192.168.1.10:8787"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
            <button className="btn" type="submit" disabled={busy || base.trim() === (baseSaved ?? "")}>
              Save
            </button>
            <p className="muted small">
              The address your {noun} use to fetch music from this server. Leave empty to use the address you opened Cadence with.
            </p>
          </form>
        </>
      ) : (
        <p className="muted small">Only a server admin can add devices by address.</p>
      )}
    </div>
  );
}
