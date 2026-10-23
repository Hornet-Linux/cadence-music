import { useState } from "react";
import type { FolderChoice } from "../_remoteSource/logic";
import { Field, FolderPicker, IndexLine, NetworkSwitch, ServerGate } from "../_remoteSource/components";
import { useWebdav, type WebdavStatus } from "./store";

function ConnectForm() {
  const connect = useWebdav((s) => s.connect);
  const busy = useWebdav((s) => s.busy);
  const error = useWebdav((s) => s.error);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <form
      className="rs-form"
      onSubmit={(e) => {
        e.preventDefault();
        void connect({ url: url.trim(), username: username.trim(), password }).then((ok) => ok && setPassword(""));
      }}
    >
      <p className="muted small">
        Enter the WebDAV address of your files. For Nextcloud or ownCloud open Files, then Settings, and copy the WebDAV address; it ends in{" "}
        <code>/remote.php/dav/files/YOUR-NAME/</code>. Use an app password rather than your main password (Settings, Security).
      </p>
      <Field label="WebDAV address" value={url} onChange={setUrl} type="url" placeholder="https://cloud.example.com/remote.php/dav/files/me/" autoComplete="url" />
      <Field label="User name" value={username} onChange={setUsername} autoComplete="username" />
      <Field
        label="Password or app password"
        value={password}
        onChange={setPassword}
        type="password"
        autoComplete="new-password"
        help="Sent to your Cadence server once, then stored encrypted there. This device never keeps it."
      />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button className="btn primary" type="submit" disabled={busy || !url.trim() || !username.trim()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}

function Connected({ status }: { status: WebdavStatus }) {
  const disconnect = useWebdav((s) => s.disconnect);
  const busy = useWebdav((s) => s.busy);
  const call = useWebdav((s) => s.call);
  const error = useWebdav((s) => s.error);
  const refresh = useWebdav((s) => s.refresh);
  const [choosing, setChoosing] = useState(false);
  const folders = status.folders ?? [];
  const initial: FolderChoice[] = folders.map((p) => ({ key: p, name: p.slice(p.lastIndexOf("/") + 1) || p }));

  return (
    <>
      <dl className="rs-facts">
        <dt>Address</dt>
        <dd>{status.address}</dd>
        <dt>User</dt>
        <dd>{status.username}</dd>
        <dt>Folders</dt>
        <dd>{folders.length === 0 ? "Everything" : folders.join(", ")}</dd>
      </dl>
      <IndexLine store={useWebdav} />
      {error && <p className="notice error">{error}</p>}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn" onClick={() => setChoosing(!choosing)} aria-expanded={choosing}>
          {choosing ? "Hide folders" : "Choose folders"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>
      {choosing && (
        <FolderPicker
          rootName="Share"
          initial={initial}
          hint="Tick the folders that hold your music. With none ticked, the whole share is searched for audio files."
          load={async (parent) => {
            const res = await call<{ folders: { name: string; path: string }[] }>(`folders${parent ? `?path=${encodeURIComponent(parent.key)}` : ""}`);
            return res.folders.map((f) => ({ key: f.path, name: f.name }));
          }}
          save={async (choices) => {
            await call("folders", { method: "PUT", body: JSON.stringify({ folders: choices.map((c) => c.key) }) });
            await refresh();
          }}
        />
      )}
    </>
  );
}

/** Connect to (or disconnect from) a WebDAV share through your Cadence server. */
export function WebdavSettings() {
  return (
    <>
      <ServerGate store={useWebdav} label="WebDAV">
        {(status) => (status.connected ? <Connected status={status} /> : <ConnectForm />)}
      </ServerGate>
      <div className="rs-root" style={{ marginTop: 16 }}>
        <NetworkSwitch store={useWebdav} />
      </div>
    </>
  );
}
