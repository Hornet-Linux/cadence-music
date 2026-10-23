import { useCallback, useEffect, useState } from "react";
import { usePluginHost } from "@/plugins/host";
import type { OutputTarget } from "../../types";
import { chooseOutput, useOutput } from "../_devices/outputState";
import "../_devices/devices.css";
import "./style.css";

type Listing =
  | { status: "loading" }
  | { status: "ok"; devices: { id: string; name: string }[] }
  | { status: "error"; message: string };

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

function DeviceButton({ name, detail, selected, disabled, onPick }: { name: string; detail?: string; selected: boolean; disabled: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      className={`po-device${selected ? " selected" : ""}`}
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onPick}
    >
      <span className="po-name">{name}</span>
      {detail && <span className="po-detail">{detail}</span>}
      {selected && (
        <span className="po-check">
          <CheckIcon />
        </span>
      )}
    </button>
  );
}

/** "Play on...": choose This device or any device the enabled plugins can find. */
/** What to try when a target finds nothing. Other Cadence players appear on their own; speakers can be added by address. */
function emptyHint(targetId: string): string {
  if (targetId.includes("remote")) return "Nothing found. Open Cadence on another device signed in to your account and it appears here.";
  return "Nothing found. Check Settings for how to add a device by address.";
}

export function OutputPicker() {
  const targets = usePluginHost((s) => s.contributions.outputTargets);
  const { active, error, busy, warnings } = useOutput();
  const [listings, setListings] = useState<Record<string, Listing>>({});

  const look = useCallback(async (target: OutputTarget) => {
    setListings((l) => ({ ...l, [target.id]: { status: "loading" } }));
    try {
      const devices = await target.listDevices();
      setListings((l) => ({ ...l, [target.id]: { status: "ok", devices } }));
    } catch (err) {
      setListings((l) => ({ ...l, [target.id]: { status: "error", message: err instanceof Error ? err.message : "Could not look for devices." } }));
    }
  }, []);

  useEffect(() => {
    for (const t of targets) void look(t);
  }, [targets, look]);

  return (
    <div className="view po-view">
      <header className="view-header">
        <h1>Play on</h1>
        <p className="muted">Choose where the music comes out. Your queue and position carry over.</p>
      </header>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <section className="po-section" aria-label="This device">
        <div role="radiogroup" aria-label="Output">
          <DeviceButton name="This device" detail="Speakers or headphones connected here" selected={active === null} disabled={busy} onPick={() => void chooseOutput(null, null)} />
        </div>
      </section>

      {targets.length === 0 && (
        <p className="empty">
          No other outputs yet. Turn on a device plugin in Settings (Remote control, DLNA and Sonos, Chromecast) and they appear here.
        </p>
      )}

      {targets.map((target) => {
        const listing = listings[target.id];
        return (
          <section key={target.id} className="po-section" aria-label={target.label}>
            <div className="po-section-head">
              <h2>{target.label}</h2>
              <button className="btn ghost" onClick={() => void look(target)} disabled={listing?.status === "loading"} aria-label={`Look for ${target.label} again`}>
                {listing?.status === "loading" ? "Looking..." : "Refresh"}
              </button>
            </div>
            {listing?.status === "error" && <p className="notice warn">{listing.message}</p>}
            {listing?.status === "ok" && listing.devices.length > 0 && warnings[target.id] && <p className="notice warn">{warnings[target.id]}</p>}
            {listing?.status === "ok" && listing.devices.length === 0 && <p className="muted small">{emptyHint(target.id)}</p>}
            {listing?.status === "ok" && listing.devices.length > 0 && (
              <div role="radiogroup" aria-label={target.label} className="po-list">
                {listing.devices.map((d) => (
                  <DeviceButton
                    key={d.id}
                    name={d.name}
                    selected={active?.targetId === target.id && active.deviceId === d.id}
                    disabled={busy}
                    onPick={() => void chooseOutput(target.id, d.id, d.name)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
