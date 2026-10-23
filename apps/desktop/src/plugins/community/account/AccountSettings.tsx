import { useCallback, useEffect, useState } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "../../builtins/server/serverStore";
import {
  agoText,
  changePassword,
  deleteAccount,
  deleteHistory,
  downloadJson,
  endOtherSessions,
  endSession,
  exportMyData,
  friendlyError,
  loadAccount,
  loadSessions,
  passwordProblem,
  saveDisplayName,
  type AccountInfo,
  type DeviceSession,
} from "./accountApi";

type Say = { text: string; bad?: boolean } | null;

function Status({ say }: { say: Say }) {
  if (!say) return null;
  return (
    <p className={`acct-status${say.bad ? " bad" : ""}`} role={say.bad ? "alert" : "status"}>
      {say.text}
    </p>
  );
}

function NameForm({ account, onSaved }: { account: AccountInfo; onSaved: (a: AccountInfo) => void }) {
  const [name, setName] = useState(account.user.displayName ?? "");
  const [say, setSay] = useState<Say>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const user = await saveDisplayName(name);
          onSaved({ ...account, user });
          useServer.setState({ user: { ...useServer.getState().user!, displayName: user.displayName } });
          setSay({ text: "Saved." });
        } catch (err) {
          setSay({ text: friendlyError(err), bad: true });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field-label" htmlFor="acct-name">
        Display name
      </label>
      <input
        id="acct-name"
        className="text-input"
        value={name}
        maxLength={80}
        placeholder={account.user.username}
        autoComplete="name"
        onChange={(e) => setName(e.target.value)}
      />
      <div className="row">
        <button className="btn" type="submit" disabled={busy || name === (account.user.displayName ?? "")}>
          Save name
        </button>
      </div>
      <Status say={say} />
    </form>
  );
}

function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [say, setSay] = useState<Say>(null);
  const [busy, setBusy] = useState(false);
  const problem = passwordProblem(next, repeat);
  const ready = current.length > 0 && next.length >= 10 && next === repeat;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setSay(null);
        try {
          const r = await changePassword(current, next);
          setCurrent("");
          setNext("");
          setRepeat("");
          setSay({
            text: `Password changed.${r.signedOut ? ` ${r.signedOut} other ${r.signedOut === 1 ? "device was" : "devices were"} signed out.` : ""}`,
          });
          onChanged();
        } catch (err) {
          setSay({ text: friendlyError(err), bad: true });
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        className="text-input"
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        aria-label="Current password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <input
        className="text-input"
        type="password"
        autoComplete="new-password"
        placeholder="New password (at least 10 characters)"
        aria-label="New password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <input
        className="text-input"
        type="password"
        autoComplete="new-password"
        placeholder="Repeat new password"
        aria-label="Repeat new password"
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
      />
      {problem && <p className="muted small">{problem}</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || !ready}>
          {busy ? "Changing…" : "Change password"}
        </button>
      </div>
      <p className="muted small">Changing it signs you out on your other devices.</p>
      <Status say={say} />
    </form>
  );
}

function Devices({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<DeviceSession[] | null>(null);
  const [say, setSay] = useState<Say>(null);
  const load = useCallback(async () => {
    try {
      setItems(await loadSessions());
    } catch (err) {
      setSay({ text: friendlyError(err), bad: true });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!items) return say ? <Status say={say} /> : <p className="muted small">Loading…</p>;
  const others = items.filter((s) => !s.current);
  return (
    <div className="stack">
      <ul className="acct-list">
        {items.map((s) => (
          <li key={s.id} className="acct-device">
            <div className="acct-grow">
              <div className="strong">
                {s.device}
                {s.current && <span className="acct-badge">This device</span>}
              </div>
              <div className="muted small">
                Active {agoText(s.lastUsedAt)} · signed in {new Date(s.createdAt).toLocaleDateString()}
                {s.ip ? ` · ${s.ip}` : ""}
              </div>
            </div>
            {!s.current && (
              <button
                className="btn ghost"
                onClick={async () => {
                  try {
                    await endSession(s.id);
                    await load();
                  } catch (err) {
                    setSay({ text: friendlyError(err), bad: true });
                  }
                }}
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      {others.length > 0 ? (
        <div>
          <button
            className="btn"
            onClick={async () => {
              try {
                const r = await endOtherSessions();
                setSay({ text: `Signed out ${r.signedOut} other ${r.signedOut === 1 ? "device" : "devices"}.` });
                await load();
              } catch (err) {
                setSay({ text: friendlyError(err), bad: true });
              }
            }}
          >
            Sign out all other devices
          </button>
        </div>
      ) : (
        <p className="muted small">No other devices are signed in.</p>
      )}
      <Status say={say} />
    </div>
  );
}

function YourData({ account, onChanged }: { account: AccountInfo; onChanged: () => void }) {
  const [say, setSay] = useState<Say>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <p className="muted small">
        {account.counts.plays.toLocaleString()} plays, {account.counts.likes.toLocaleString()} liked songs and{" "}
        {account.counts.playlists.toLocaleString()} playlists are kept on your server.
      </p>
      <div className="row acct-wrap">
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              downloadJson(await exportMyData(), `cadence-${account.user.username}.json`);
              setSay({ text: "Downloaded. The file never includes passwords or access tokens." });
            } catch (err) {
              setSay({ text: friendlyError(err), bad: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          Download my data
        </button>
        {!confirming && (
          <button className="btn ghost danger-text" onClick={() => setConfirming(true)} disabled={account.counts.plays === 0}>
            Delete my listening history
          </button>
        )}
      </div>
      {confirming && (
        <div className="notice error stack" role="alertdialog" aria-label="Confirm deleting history">
          <span>
            Delete all {account.counts.plays.toLocaleString()} plays from every device? Liked songs and playlists stay. This can&apos;t
            be undone.
          </span>
          <div className="row acct-wrap">
            <button
              className="btn danger-solid"
              onClick={async () => {
                try {
                  const r = await deleteHistory();
                  setSay({ text: `Deleted ${r.deleted.toLocaleString()} plays.` });
                  setConfirming(false);
                  onChanged();
                } catch (err) {
                  setSay({ text: friendlyError(err), bad: true });
                }
              }}
            >
              Yes, delete history
            </button>
            <button className="btn ghost" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}
      <Status say={say} />
    </div>
  );
}

function DeleteAccount({ account }: { account: AccountInfo }) {
  const [open, setOpen] = useState(false);
  const [proof, setProof] = useState("");
  const [say, setSay] = useState<Say>(null);
  const [busy, setBusy] = useState(false);
  const usesPassword = account.signIn.password;
  if (!open) {
    return (
      <div>
        <button className="btn ghost danger-text" onClick={() => setOpen(true)}>
          Delete my account…
        </button>
      </div>
    );
  }
  return (
    <form
      className="notice error stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await deleteAccount(usesPassword ? { password: proof } : { confirm: proof });
          await useServer.getState().logout();
        } catch (err) {
          setSay({ text: friendlyError(err), bad: true });
          setBusy(false);
        }
      }}
    >
      <span>
        This permanently removes your account, history, liked songs and playlists from this server. Download your data first if you want a copy.
      </span>
      <input
        className="text-input"
        type={usesPassword ? "password" : "text"}
        autoComplete={usesPassword ? "current-password" : "off"}
        placeholder={usesPassword ? "Your password" : `Type your username (${account.user.username})`}
        aria-label={usesPassword ? "Your password" : "Your username"}
        value={proof}
        onChange={(e) => setProof(e.target.value)}
      />
      <div className="row acct-wrap">
        <button className="btn danger-solid" type="submit" disabled={busy || !proof}>
          {busy ? "Deleting…" : "Delete my account"}
        </button>
        <button className="btn ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Status say={say} />
    </form>
  );
}

/** Your own account on the Cadence server: password, devices, data. */
export function AccountSettings() {
  const user = useServer((s) => s.user);
  const url = useServer((s) => s.url);
  const logout = useServer((s) => s.logout);
  const openSettings = useSettingsModal((s) => s.show);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceKey, setDeviceKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setAccount(await loadAccount());
      setError(null);
    } catch (err) {
      setError(friendlyError(err));
    }
  }, []);
  useEffect(() => {
    setAccount(null);
    if (user) void refresh();
  }, [user?.id, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) {
    return (
      <div className="stack">
        <p className="muted small">Sign in to your Cadence server to manage your password, devices and data.</p>
        <div>
          <button className="btn" onClick={() => openSettings("server")}>
            Open server settings
          </button>
        </div>
      </div>
    );
  }
  if (!account) {
    return (
      <div className="stack">
        {error ? <p className="notice error">{error}</p> : <p className="muted small">Loading your account…</p>}
        {error && (
          <div>
            <button className="btn ghost" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="stack acct">
      <div className="signed-in">
        <div>
          <div className="strong">{account.user.displayName ?? account.user.username}</div>
          <div className="muted small">
            @{account.user.username}
            {account.user.isAdmin ? " · admin" : ""} · member since {new Date(account.createdAt).toLocaleDateString()}
          </div>
        </div>
        <button className="btn ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </div>

      <section className="acct-section">
        <h3>Profile</h3>
        <NameForm account={account} onSaved={setAccount} />
      </section>

      <section className="acct-section">
        <h3>Password</h3>
        {account.signIn.password ? (
          <PasswordForm onChanged={() => setDeviceKey((k) => k + 1)} />
        ) : (
          <p className="muted small">
            You sign in with {account.signIn.sso ?? "single sign-on"}, so there&apos;s no Cadence password to change. Manage it with
            your identity provider.
          </p>
        )}
      </section>

      <section className="acct-section">
        <h3>Devices</h3>
        <p className="muted small">Where you&apos;re signed in. Sign out anything you don&apos;t recognise.</p>
        <Devices refreshKey={deviceKey} />
      </section>

      <section className="acct-section">
        <h3>Your data</h3>
        <YourData account={account} onChanged={() => void refresh()} />
      </section>

      <section className="acct-section">
        <h3>Delete account</h3>
        <DeleteAccount account={account} />
      </section>

      <p className="muted small">
        The same page works in any browser:{" "}
        <a href={`${url}/account`} target="_blank" rel="noreferrer">
          {url.replace(/^https?:\/\//, "")}/account
        </a>
        {account.user.isAdmin && (
          <>
            {" · "}
            <a href={`${url}/admin`} target="_blank" rel="noreferrer">
              Admin panel
            </a>
          </>
        )}
      </p>
    </div>
  );
}