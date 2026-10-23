import type { ReactNode } from "react";
import type { ServerTrack } from "@uma/shared";
import type { Track } from "@/shared/types";
import { SERVER_TRACK_PREFIX } from "../../builtins/server/serverStore";
import { explainError, isMissingFeature, useServerSession } from "./api";
import "./style.css";

/** Turn a server library track into the player's Track (same mapping as the Server plugin). */
export function serverTrackToTrack(
  t: Pick<ServerTrack, "id" | "title" | "artist" | "album" | "durationSec"> & { albumArtist?: string | null },
): Track {
  const artist = t.artist ?? t.albumArtist ?? null;
  return {
    id: `${SERVER_TRACK_PREFIX}${t.id}`,
    title: t.title,
    artists: [{ id: artist ?? "unknown", name: artist ?? "Unknown artist" }],
    album: t.album ?? undefined,
    durationSec: t.durationSec ?? undefined,
    source: "server",
  };
}

/** Wraps a page: asks the person to sign in, or to be an admin, before showing it. */
export function Gate({ admin, children }: { admin?: boolean; children: ReactNode }) {
  const { signedIn, isAdmin } = useServerSession();
  if (!signedIn) {
    return <p className="notice">Sign in to your Cadence server (Settings, Server) to use this.</p>;
  }
  if (admin && !isAdmin) return <p className="notice">This page is for the server admin.</p>;
  return <>{children}</>;
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className={isMissingFeature(error) ? "notice" : "notice error"}>{explainError(error)}</p>;
}

export function Page({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="view sl-page">
      <header className="view-header">
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </header>
      {children}
    </div>
  );
}

export function Progress({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      className="sl-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
    >
      <div className="sl-progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "warn" }) {
  return (
    <div className={`sl-stat card${tone ? ` ${tone}` : ""}`}>
      <div className="sl-stat-value">{value}</div>
      <div className="sl-stat-label muted small">{label}</div>
    </div>
  );
}

/** A tab strip that scrolls sideways on narrow screens. */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: string; count?: number }[];
}) {
  return (
    <div className="sl-tabs" role="tablist">
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={value === it.id}
          className={value === it.id ? "on" : ""}
          onClick={() => onChange(it.id)}
        >
          {it.label}
          {it.count !== undefined && <span className="sl-count">{it.count.toLocaleString()}</span>}
        </button>
      ))}
    </div>
  );
}
