import { useState } from "react";
import { isInsecureRemote, useServer } from "./serverStore";

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${status}`} aria-hidden />;
}

export function ServerSettings() {
  const s = useServer();
  // null until the user edits it, so the saved URL shows once it has loaded.
  const [editedUrl, setUrlInput] = useState<string | null>(null);
  const urlInput = editedUrl ?? s.url;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const statusText =
    s.status === "online"
      ? `Connected to ${s.health?.name ?? "server"} ${s.health?.version ?? ""}`.trim()
      : s.status === "checking"
        ? "Connecting…"
        : s.status === "offline"
          ? "Can't reach this server"
          : "Not connected";

  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void s.connect(urlInput);
        }}
      >
        <input
          className="text-input"
          placeholder="music.example.com"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          aria-label="Server address"
        />
        <button className="btn" type="submit" disabled={s.status === "checking" || !urlInput.trim()}>
          Connect
        </button>
      </form>

      <div className="status-line">
        <StatusDot status={s.status} />
        <span className="muted small">{statusText}</span>
      </div>

      {isInsecureRemote(s.url) && (
        <p className="notice warn">
          This server uses plain http. Sign-in details and music travel unencrypted — use https
          (for example behind Caddy) for anything beyond your local network.
        </p>
      )}

      {s.status === "online" && !s.user && (
        <div className="stack">
          {s.health?.auth.oidc && (
            <button className="btn primary" disabled={s.busy} onClick={() => void s.loginOidc()}>
              {s.busy ? "Waiting for browser…" : `Sign in with ${s.health.auth.oidc.name}`}
            </button>
          )}
          {s.health?.auth.password && (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void s.loginPassword(username, password).then(() => setPassword(""));
              }}
            >
              {s.health.auth.oidc && <div className="divider-label">or</div>}
              <input
                className="text-input"
                placeholder="Username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                className="text-input"
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button className="btn" type="submit" disabled={s.busy || !username || !password}>
                Sign in
              </button>
            </form>
          )}
          {!s.health?.auth.oidc && !s.health?.auth.password && (
            <p className="muted small">
              This server has no sign-in method configured yet. Set ADMIN_USERNAME/ADMIN_PASSWORD
              or OIDC on the server.
            </p>
          )}
        </div>
      )}

      {s.user && (
        <div className="signed-in">
          <div>
            <div className="strong">{s.user.displayName ?? s.user.username}</div>
            <div className="muted small">
              {s.user.email ?? s.user.username}
              {s.user.isAdmin ? " · admin" : ""} · {s.total} tracks
            </div>
          </div>
          <div className="row">
            {s.user.isAdmin && (
              <button className="btn ghost" disabled={s.busy} onClick={() => void s.rescan()}>
                {s.busy ? "Scanning…" : "Rescan library"}
              </button>
            )}
            <button className="btn ghost" onClick={() => void s.logout()}>
              Sign out
            </button>
          </div>
        </div>
      )}

      {s.error && <p className="notice error">{s.error}</p>}
    </div>
  );
}
