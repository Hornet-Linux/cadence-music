import { useState } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "../server/serverStore";
import { useJellyfin } from "./jellyfinStore";

/** Sign in to (or out of) the Jellyfin library behind your Cadence server. */
export function JellyfinSettings() {
  const { status, checking, busy, error, trackTotal, connect, disconnect, refresh } = useJellyfin();
  const serverUser = useServer((s) => s.user);
  const openSettings = useSettingsModal((s) => s.show);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (!serverUser) {
    return (
      <div className="stack">
        <p className="muted small">
          Jellyfin connects through your Cadence server, so sign in to the server first. Your server owner chooses which Jellyfin it
          uses; you only need your own Jellyfin account.
        </p>
        <div>
          <button className="btn" onClick={() => openSettings("server")}>
            Open server settings
          </button>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="stack">
        <p className="muted small">{checking ? "Checking Jellyfin…" : "Couldn't check Jellyfin."}</p>
        {error && <p className="notice error">{error}</p>}
        {!checking && (
          <div>
            <button className="btn ghost" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!status.configured) {
    return (
      <div className="stack">
        <p className="notice">
          Jellyfin isn&apos;t set up on this server. Ask the server owner to add its Jellyfin address; see{" "}
          <a href="https://github.com/Hornet-Linux/cadence-music/blob/main/docs/JELLYFIN.md" target="_blank" rel="noreferrer">
            docs/JELLYFIN.md
          </a>
          .
        </p>
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
            <div className="strong">{status.userName ?? "Jellyfin"}</div>
            <div className="muted small">
              {status.serverName ? `On ${status.serverName}` : "Connected"}
              {trackTotal > 0 ? ` · ${trackTotal} tracks` : ""}
            </div>
          </div>
          <div className="row">
            <button className="btn ghost" disabled={busy} onClick={() => void disconnect()}>
              Sign out
            </button>
          </div>
        </div>
        {error && <p className="notice error">{error}</p>}
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void connect(username, password).then((ok) => ok && setPassword(""));
      }}
    >
      <p className="muted small">
        Sign in with your own Jellyfin account to browse and play your music here. The password goes to your Cadence server once
        and isn&apos;t stored.
      </p>
      <input
        className="text-input"
        placeholder="Jellyfin username"
        autoComplete="username"
        spellCheck={false}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        aria-label="Jellyfin username"
      />
      <input
        className="text-input"
        type="password"
        placeholder="Jellyfin password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-label="Jellyfin password"
      />
      {error && <p className="notice error">{error}</p>}
      <div>
        <button className="btn primary" type="submit" disabled={busy || !username.trim()}>
          {busy ? "Signing in…" : "Sign in to Jellyfin"}
        </button>
      </div>
    </form>
  );
}
