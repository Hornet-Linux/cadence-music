import { useEffect, useState } from "react";
import { describeError, useIsAdmin } from "../_sourcekit/api";
import { SignInGate } from "../_sourcekit/ui";
import { getAdminAddress, saveAdminAddress, testAdminAddress, useAudiobooks } from "./audiobookStore";

function AdminAddress() {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    void getAdminAddress().then(
      (a) => {
        setSaved(a);
        setValue(a ?? "");
      },
      (e: unknown) => setMsg({ text: describeError(e, "audiobooks"), error: true }),
    );
  }, []);
  async function run(task: () => Promise<string>) {
    setMsg(null);
    try {
      setMsg({ text: await task(), error: false });
    } catch (e) {
      setMsg({ text: describeError(e, "audiobooks"), error: true });
    }
  }
  return (
    <div className="stack">
      <p className="strong">Audiobookshelf address (server owner)</p>
      <p className="muted small">The address your Cadence server uses to reach Audiobookshelf, such as http://audiobookshelf:13378. Everyone signs in with their own Audiobookshelf account.</p>
      <input className="sk-field" placeholder="http://audiobookshelf:13378" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Audiobookshelf address" inputMode="url" autoCapitalize="off" autoCorrect="off" />
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          className="btn"
          style={{ minHeight: 44 }}
          disabled={!value.trim()}
          onClick={() =>
            void run(async () => {
              const url = await saveAdminAddress(value.trim());
              setSaved(url);
              setValue(url ?? "");
              void useAudiobooks.getState().refreshStatus();
              return "Saved.";
            })
          }
        >
          Save
        </button>
        <button
          className="btn ghost"
          style={{ minHeight: 44 }}
          disabled={!value.trim()}
          onClick={() =>
            void run(async () => {
              const r = await testAdminAddress(value.trim());
              if (!r.ok) throw new Error(r.message ?? "That didn't work.");
              return "Audiobookshelf answered.";
            })
          }
        >
          Test
        </button>
        {saved && (
          <button
            className="btn ghost"
            style={{ minHeight: 44 }}
            onClick={() =>
              void run(async () => {
                await saveAdminAddress(null);
                setSaved(null);
                setValue("");
                void useAudiobooks.getState().refreshStatus();
                return "Removed.";
              })
            }
          >
            Remove
          </button>
        )}
      </div>
      {msg && (
        <p className={msg.error ? "notice error" : "muted small"} role={msg.error ? "alert" : "status"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

export function AudiobookSettings() {
  const { status, checking, busy, error, connect, disconnect, refreshStatus } = useAudiobooks();
  const isAdmin = useIsAdmin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => {
    if (!status) void refreshStatus();
  }, [status, refreshStatus]);

  return (
    <SignInGate what="Audiobookshelf">
      <div className="stack">
        {!status ? (
          <p className="muted small">{checking ? "Checking Audiobookshelf…" : (error ?? "Couldn't check Audiobookshelf.")}</p>
        ) : !status.configured ? (
          <p className="notice">Audiobookshelf isn&apos;t set up on this server yet.{isAdmin ? " Add its address below." : " Ask the server owner to add its address."}</p>
        ) : status.connected ? (
          <div className="signed-in">
            <div>
              <div className="strong">{status.userName ?? "Audiobookshelf"}</div>
              <div className="muted small">Connected. Your place in each book is saved back to Audiobookshelf.</div>
            </div>
            <div className="row">
              <button className="btn ghost" style={{ minHeight: 44 }} disabled={busy} onClick={() => void disconnect()}>
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void connect(username, password).then((ok) => ok && setPassword(""));
            }}
          >
            <p className="muted small">Sign in with your own Audiobookshelf account. Cadence keeps the sign-in on your server (encrypted) and never stores your password.</p>
            <input className="sk-field" placeholder="User name" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Audiobookshelf user name" autoComplete="username" autoCapitalize="off" autoCorrect="off" />
            <input className="sk-field" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Audiobookshelf password" autoComplete="current-password" />
            <div>
              <button className="btn primary" type="submit" style={{ minHeight: 44 }} disabled={busy || !username.trim() || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </div>
          </form>
        )}
        {error && status && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {isAdmin && <AdminAddress />}
      </div>
    </SignInGate>
  );
}