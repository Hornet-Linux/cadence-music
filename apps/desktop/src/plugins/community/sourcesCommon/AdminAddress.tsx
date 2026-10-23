import { useCallback, useEffect, useState } from "react";
import "./style.css";

export interface AddressInfo {
  serverUrl: string | null;
  source: "env" | "admin" | null;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  serverName?: string;
  version?: string;
}

/** The owner's form for where the music server is (shown to admins only). */
export function AdminAddress({
  label,
  example,
  load,
  save,
  test,
  onChanged,
}: {
  label: string;
  example: string;
  load: () => Promise<AddressInfo>;
  save: (url: string | null) => Promise<AddressInfo>;
  test: (url: string) => Promise<TestResult>;
  onChanged?: () => void;
}) {
  const [info, setInfo] = useState<AddressInfo | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await load();
      setInfo(next);
      setValue(next.serverUrl ?? "");
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try {
      await task();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const locked = info?.source === "env";
  return (
    <div className="src-address">
      <label className="field-label" htmlFor={`${label}-address`}>
        {label} server address (as the Cadence server reaches it)
      </label>
      <input
        id={`${label}-address`}
        className="text-input"
        placeholder={example}
        spellCheck={false}
        autoCapitalize="off"
        value={value}
        disabled={locked || !info}
        onChange={(e) => setValue(e.target.value)}
      />
      {locked && <p className="muted small">Set by an environment variable on the server, which takes precedence.</p>}
      {!locked && (
        <div className="src-actions">
          <button
            className="btn ghost"
            disabled={busy || !value.trim()}
            onClick={() =>
              void run(async () => {
                const r = await test(value);
                setNote(
                  r.ok
                    ? { ok: true, text: `Reached ${label}${r.serverName ? ` (${r.serverName})` : ""}${r.version ? ` ${r.version}` : ""}.` }
                    : { ok: false, text: r.error ?? "That didn't work." },
                );
              })
            }
          >
            Test
          </button>
          <button
            className="btn primary"
            disabled={busy || !info || value.trim() === (info.serverUrl ?? "")}
            onClick={() =>
              void run(async () => {
                const next = await save(value.trim() || null);
                setInfo(next);
                setValue(next.serverUrl ?? "");
                setNote({ ok: true, text: next.serverUrl ? "Saved." : "Removed." });
                onChanged?.();
              })
            }
          >
            Save
          </button>
          {info?.serverUrl && (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await save(null);
                  setInfo(next);
                  setValue("");
                  setNote({ ok: true, text: "Removed." });
                  onChanged?.();
                })
              }
            >
              Remove
            </button>
          )}
        </div>
      )}
      {note && (
        <p className={note.ok ? "notice" : "notice error"} role="status">
          {note.text}
        </p>
      )}
    </div>
  );
}