import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { ApiError, apiUrl, useServer } from "@/plugins/builtins/server/serverStore";
import "./ops.css";

/** What the server said went wrong, in a sentence a person can act on. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This feature is not switched on for your server. An admin can turn it on under Settings, Plugins, on the server's admin page.";
    if (err.status === 403) return "Only server admins can do this.";
    if (err.status === 429) return err.message.replace(/^Request failed \(429\): ?/, "") || "Too many requests. Try again later.";
    return err.message.replace(/^Request failed \(\d+\): ?/, "") || "The request failed.";
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

/** The server API as plugin code uses it, plus who is signed in. */
export function useOps() {
  const api = useServer((s) => s.api);
  const user = useServer((s) => s.user);
  const url = useServer((s) => s.url);
  return { api, user, url, signedIn: Boolean(user), isAdmin: Boolean(user?.isAdmin) };
}

/** Load something when the page opens (and again on `reload`). */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    loadRef.current().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (err) => alive && setState({ data: null, error: describeError(err), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

/** Run an action with a busy flag and an error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(describeError(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/** Fetch a file with the signed-in session and hand it to the browser as a download. */
export async function downloadFile(route: string, fallbackName: string): Promise<void> {
  const { url, token } = useServer.getState();
  if (!url) throw new Error("Connect to your server first.");
  const res = await fetch(apiUrl(url, route), { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let message = `The download failed (${res.status}).`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error?.replace(/_/g, " ") ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : (plain ?? fallbackName);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatWhen(ms: number | null | undefined): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatHours(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const m = Math.round(seconds / 60);
  return m < 90 ? `${m} min` : `${(seconds / 3600).toFixed(1)} h`;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "ok" | "warn"; children: ReactNode }) {
  return (
    <div className={`ops-notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/** A page of a community plugin: the standard view header plus muted sections. */
export function OpsPage({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="view ops">
      <header className="view-header">
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </header>
      <div className="ops-stack">{children}</div>
    </div>
  );
}

export function Section({ title, hint, children, actions }: { title: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card ops-section">
      <div className="ops-section-head">
        <div>
          <h2>{title}</h2>
          {hint && <p className="muted small">{hint}</p>}
        </div>
        {actions && <div className="ops-section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Shown instead of a feature while there is no signed-in server account. */
export function NeedServer({ children }: { children: ReactNode }) {
  const { signedIn } = useOps();
  const open = useSettingsModal((s) => s.show);
  if (signedIn) return <>{children}</>;
  return (
    <Section title="Sign in to your server">
      <p className="muted">This feature works with your Cadence server. Connect and sign in first.</p>
      <div>
        <button className="btn" onClick={() => open("server")}>
          Open server settings
        </button>
      </div>
    </Section>
  );
}

export function NeedAdmin({ children }: { children: ReactNode }) {
  const { signedIn, isAdmin } = useOps();
  const open = useSettingsModal((s) => s.show);
  if (!signedIn) {
    return (
      <div className="ops-stack">
        <p className="muted">Sign in to your server to manage this.</p>
        <div>
          <button className="btn" onClick={() => open("server")}>
            Open server settings
          </button>
        </div>
      </div>
    );
  }
  if (!isAdmin) return <p className="muted">Only server admins can manage this.</p>;
  return <>{children}</>;
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="ops-field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="muted small">{hint}</p>}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="ops-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}
/** Copies text to the clipboard (falls back to selecting it when the browser blocks clipboard access). */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          window.prompt("Copy this:", text);
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}