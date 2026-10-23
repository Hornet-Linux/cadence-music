import { useCallback, useState } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "../../builtins/server/serverStore";
import { AdminAddress, type AddressInfo, type TestResult } from "../sourcesCommon/AdminAddress";
import "../sourcesCommon/style.css";
import { useSubsonic } from "./subsonicStore";

/** The server owner's form for where the Subsonic server is. */
function OwnerAddress() {
  const refresh = useSubsonic((s) => s.refresh);
  const api = useServer.getState().api;
  const load = useCallback(() => useServer.getState().api<AddressInfo>("api/admin/subsonic"), []);
  const save = useCallback((url: string | null) => api<AddressInfo>("api/admin/subsonic", { method: "PUT", body: JSON.stringify({ serverUrl: url }) }), [api]);
  const test = useCallback((url: string) => api<TestResult>("api/admin/subsonic/test", { method: "POST", body: JSON.stringify({ serverUrl: url }) }), [api]);
  return (
    <div className="stack">
      <p className="strong">Server owner</p>
      <AdminAddress label="Subsonic" example="http://navidrome:4533" load={load} save={save} test={test} onChanged={() => void refresh()} />
    </div>
  );
}

/** Sign in to (or out of) the Subsonic-compatible server behind your Cadence server (Navidrome, Airsonic-Advanced, Gonic). */
export function SubsonicSettings() {
  const { status, checking, busy, error, tracks, connect, disconnect, refresh } = useSubsonic();
  const serverUser = useServer((s) => s.user);
  const openSettings = useSettingsModal((s) => s.show);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (!serverUser) {
    return (
      <div className="stack">
        <p className="muted small">
          Subsonic connects through your Cadence server, so sign in to the server first. Your server owner chooses which Subsonic server it uses; you only
          need your own account there.
        </p>
        <div>
          <button className="btn" onClick={() => openSettings("server")}>
            Open server settings
          </button>
        </div>
      </div>
    );
  }

  const owner = serverUser.isAdmin ? <OwnerAddress /> : null;

  if (!status) {
    return (
      <div className="stack">
        <p className="muted small">{checking ? "Checking Subsonic…" : "Couldn't check Subsonic."}</p>
        {error && <p className="notice error">{error}</p>}
        {!checking && (
          <div>
            <button className="btn ghost" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        {owner}
      </div>
    );
  }

  if (!status.configured) {
    return (
      <div className="stack">
        <p className="notice">
          {serverUser.isAdmin
            ? "Subsonic isn't set up yet. Add your server's address below."
            : "Subsonic isn't set up on this server. Ask the server owner to add its address."}
        </p>
        {owner}
        <div>
          <button className="btn ghost" disabled={checking} onClick={() => void refresh()}>
            Check again
          </button>
        </div>
      </div>
    );
  }

  if (status.connected) {
    return (
      <div className="stack">
        <div className="signed-in">
          <div>
            <div className="strong">{status.userName ?? "Subsonic"}</div>
            <div className="muted small">
              {status.serverName ? `On ${status.serverName}` : "Connected"}
              {tracks.length > 0 ? ` · ${tracks.length}${tracks.length >= 200 ? "+" : ""} tracks loaded` : ""}
            </div>
          </div>
          <div className="row">
            <button className="btn ghost" disabled={busy} onClick={() => void disconnect()}>
              Sign out
            </button>
          </div>
        </div>
        {error && <p className="notice error">{error}</p>}
        {owner}
      </div>
    );
  }

  return (
    <div className="stack">
      <form
        className="stack src-form"
        onSubmit={(e) => {
          e.preventDefault();
          void connect(username, password).then((ok) => ok && setPassword(""));
        }}
      >
        <p className="muted small">
          Sign in with your own account on the Subsonic server (Navidrome, Airsonic-Advanced, Gonic...). Subsonic has no sign-in tokens, so Cadence keeps your
          password on the server, encrypted, to sign each request.
        </p>
        <input
          className="text-input"
          placeholder="Subsonic username"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-label="Subsonic username"
        />
        <input
          className="text-input"
          type="password"
          placeholder="Subsonic password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Subsonic password"
        />
        {error && <p className="notice error">{error}</p>}
        <div>
          <button className="btn primary" type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? "Signing in…" : "Sign in to Subsonic"}
          </button>
        </div>
      </form>
      {owner}
    </div>
  );
}