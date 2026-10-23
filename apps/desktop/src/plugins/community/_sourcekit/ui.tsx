import type { ReactNode } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { CoverArt } from "@/ui/CoverArt";
import { fraction } from "./format";
export { joinFacts } from "./format";
import { useSignedIn } from "./api";
import "./sourcekit.css";

/** Shown instead of a source's page until the person is signed in to a Cadence server (these all live behind it). */
export function SignInGate({ what, children }: { what: string; children: ReactNode }) {
  const signedIn = useSignedIn();
  const openSettings = useSettingsModal((s) => s.show);
  if (signedIn) return <>{children}</>;
  return (
    <div className="card pad stack">
      <p className="strong">Sign in to your server first</p>
      <p className="muted">{what} goes through your Cadence server, so connect to it first.</p>
      <div>
        <button className="btn primary" onClick={() => openSettings("server")}>
          Open server settings
        </button>
      </div>
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="view-header">
      <h1>{title}</h1>
      {children && <p className="muted">{children}</p>}
    </header>
  );
}

export function Problem({ message, onRetry }: { message: string | null; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <div className="notice error sk-problem" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button className="btn ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Art({ src, seed, label, size = 52 }: { src?: string; seed: string; label: string; size?: number }) {
  return (
    <span className="sk-art" style={{ width: size, height: size }}>
      <CoverArt src={src} seed={seed} label={label} showInitial={false} />
    </span>
  );
}

export function Bar({ position, duration, label }: { position: number; duration: number; label?: string }) {
  const f = fraction(position, duration);
  if (f <= 0) return null;
  return (
    <span className="sk-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)} aria-label={label ?? "Progress"}>
      <span style={{ width: `${f * 100}%` }} />
    </span>
  );
}

/** A round 44px button (icon only). */
export function IconButton({ label, onClick, children, pressed, disabled }: { label: string; onClick: () => void; children: ReactNode; pressed?: boolean; disabled?: boolean }) {
  return (
    <button className={`sk-icon${pressed ? " on" : ""}`} onClick={onClick} aria-label={label} aria-pressed={pressed} title={label} disabled={disabled}>
      {children}
    </button>
  );
}

export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="sk-chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={`sk-chip${value === o.value ? " on" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Placeholder rows shaped like the real list, so the page doesn't jump when results arrive. */
export function LoadingRows({ rows = 5, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="sk-list sk-loading" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="sk-ghost" key={i} aria-hidden="true">
          <span className="skeleton sk-ghost-art" />
          <span className="sk-ghost-lines">
            <span className="skeleton sk-ghost-line" />
            <span className="skeleton sk-ghost-line short" />
          </span>
        </div>
      ))}
    </div>
  );
}
