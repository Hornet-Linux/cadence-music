import { useState } from "react";
import { changeNativeServer, isNativeApp } from "@/platform/webHost";
import { isInsecureRemote, useServer } from "./serverStore";

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${status}`} aria-hidden />;
}

/** Shown on a brand-new server: claim it with the code from its logs. */
function SetupAdminForm() {
  const s = useServer();
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < 10;

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void s.setupAdmin(code, username, password);
      }}
    >
      <p className="notice">
        This is a new server. Create its admin account with the one-time setup code from the
        server's logs — run <code>docker compose logs server | grep &quot;setup code&quot;</code> in
        the <code>deploy</code> folder.
      </p>
      <input
        className="text-input"
        placeholder="Setup code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        aria-label="Setup code"
      />
      <input
        className="text-input"
        placeholder="Admin username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        aria-label="Admin username"
      />
      <input
        className="text-input"
        type="password"
        placeholder="Password (at least 10 characters)"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-label="Password"
      />
      <input
        className="text-input"
        type="password"
        placeholder="Repeat password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        aria-label="Repeat password"
      />
      {(mismatch || tooShort) && (
        <p className="muted small">
          {mismatch ? "The passwords don't match." : "Use at least 10 characters."}
        </p>
      )}
      <div>
        <button
          className="btn primary"
          type="submit"
          disabled={s.busy || !code.trim() || !username.trim() || password.length < 10 || confirm !== password}
        >
          {s.busy ? "Creating…" : "Create admin account"}
        </button>
      </div>
    </form>
  );
}

/** Create an account on a server whose owner allows sign-up. */
function RegisterForm({ invite, onBack }: { invite: boolean; onBack: () => void }) {
  const s = useServer();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = username.trim() && password.length >= 10 && confirm === password && (!invite || inviteCode.trim());

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void s.register({ username, password, inviteCode: invite ? inviteCode : undefined });
      }}
    >
      <input
        className="text-input"
        placeholder="Choose a username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        aria-label="Username"
      />
      <input
        className="text-input"
        type="password"
        placeholder="Password (at least 10 characters)"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-label="Password"
      />
      <input
        className="text-input"
        type="password"
        placeholder="Repeat password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        aria-label="Repeat password"
      />
      {invite && (
        <input
          className="text-input"
          placeholder="Invite code"
          autoComplete="off"
          spellCheck={false}
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          aria-label="Invite code"
        />
      )}
      {mismatch && <p className="muted small">The passwords don't match.</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={s.busy || !ready}>
          {s.busy ? "Creating…" : "Create account"}
        </button>
        <button className="btn ghost" type="button" onClick={onBack}>
          I already have an account
        </button>
      </div>
    </form>
  );
}

export function ServerSettings() {
  const s = useServer();
  // null until the user edits it, so the saved URL shows once it has loaded.
  const [editedUrl, setUrlInput] = useState<string | null>(null);
  const urlInput = editedUrl ?? s.url;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  // Older servers don't report sign-up; treat that as closed.
  const signupOpen = !!s.health?.auth.signup && s.health.auth.signup !== "closed";

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
        className="row server-address-form"
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
        {isNativeApp() && (
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={changeNativeServer}>
            Change server
          </button>
        )}
      </div>

      {isInsecureRemote(s.url) && (
        <p className="notice warn">
          This server uses plain http. Sign-in details and music travel unencrypted — use https
          (for example behind Caddy) for anything beyond your local network.
        </p>
      )}

      {s.status === "online" && !s.user && s.health?.setupRequired && <SetupAdminForm />}

      {s.status === "online" && !s.user && !s.health?.setupRequired && creating && (
        <RegisterForm invite={s.health?.auth.signup === "invite"} onBack={() => setCreating(false)} />
      )}

      {s.status === "online" && !s.user && !s.health?.setupRequired && !creating && (
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
          {signupOpen && (
            <button className="btn ghost" onClick={() => setCreating(true)}>
              New here? Create an account
            </button>
          )}
          {!s.health?.auth.oidc && !s.health?.auth.password && !signupOpen && (
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
