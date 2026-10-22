import { useState } from "react";
import type { FolderChoice } from "../_remoteSource/logic";
import { Field, FolderPicker, IndexLine, NetworkSwitch, ServerGate } from "../_remoteSource/components";
import { PRESETS, useS3, type S3Status } from "./store";

function ConnectForm() {
  const connect = useS3((s) => s.connect);
  const busy = useS3((s) => s.busy);
  const error = useS3((s) => s.error);
  const [preset, setPreset] = useState(PRESETS[0]!.id);
  const [endpoint, setEndpoint] = useState(PRESETS[0]!.endpoint);
  const [region, setRegion] = useState(PRESETS[0]!.region);
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [pathStyle, setPathStyle] = useState(false);
  const current = PRESETS.find((p) => p.id === preset) ?? PRESETS[0]!;

  function pick(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPreset(id);
    setEndpoint(p.endpoint);
    setRegion(p.region);
  }

  return (
    <form
      className="rs-form"
      onSubmit={(e) => {
        e.preventDefault();
        void connect({
          endpoint: endpoint.trim(),
          region: region.trim(),
          bucket: bucket.trim(),
          accessKeyId: accessKeyId.trim(),
          secretAccessKey,
          ...(pathStyle ? { pathStyle: true } : {}),
        }).then((ok) => ok && setSecretAccessKey(""));
      }}
    >
      <label className="rs-field">
        <span className="field-label">Service</span>
        <select className="text-input" value={preset} onChange={(e) => pick(e.target.value)} aria-label="Service">
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="muted small">{current.help}</span>
      </label>
      {preset !== "aws" && <Field label="Endpoint" value={endpoint} onChange={setEndpoint} type="url" placeholder="https://s3.example.com" autoComplete="url" />}
      <Field label="Region" value={region} onChange={setRegion} placeholder="us-east-1" />
      <Field label="Bucket" value={bucket} onChange={setBucket} placeholder="my-music" />
      <Field label="Access key ID" value={accessKeyId} onChange={setAccessKeyId} autoComplete="username" />
      <Field
        label="Secret access key"
        value={secretAccessKey}
        onChange={setSecretAccessKey}
        type="password"
        autoComplete="new-password"
        help="Use a key that can only read. It is sent to your Cadence server once and stored encrypted there; this device never keeps it."
      />
      {preset !== "aws" && (
        <label className="rs-switch-row">
          <span>
            <span className="strong">Put the bucket name in the path</span>
            <span className="muted small" style={{ display: "block" }}>
              Leave this off unless the connection fails. Most self-hosted servers need it on.
            </span>
          </span>
          <input type="checkbox" checked={pathStyle} onChange={(e) => setPathStyle(e.target.checked)} style={{ width: 22, height: 22 }} aria-label="Put the bucket name in the path" />
        </label>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button className="btn primary" type="submit" disabled={busy || !bucket.trim() || !accessKeyId.trim() || !secretAccessKey}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}

function Connected({ status }: { status: S3Status }) {
  const disconnect = useS3((s) => s.disconnect);
  const busy = useS3((s) => s.busy);
  const call = useS3((s) => s.call);
  const error = useS3((s) => s.error);
  const refresh = useS3((s) => s.refresh);
  const [choosing, setChoosing] = useState(false);
  const folders = status.folders ?? [];
  const initial: FolderChoice[] = folders.map((p) => ({ key: p, name: p.replace(/\/$/, "").split("/").pop() || p }));

  return (
    <>
      <dl className="rs-facts">
        <dt>Bucket</dt>
        <dd>{status.bucket}</dd>
        <dt>Service</dt>
        <dd>{status.endpoint ?? `Amazon S3, ${status.region}`}</dd>
        <dt>Access key</dt>
        <dd>{status.accessKeyId}</dd>
        <dt>Folders</dt>
        <dd>{folders.length === 0 ? "Everything" : folders.join(", ")}</dd>
      </dl>
      <IndexLine store={useS3} />
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
          rootName="Bucket"
          initial={initial}
          hint="Folders in a bucket are key prefixes. Tick the ones that hold your music; with none ticked, the whole bucket is searched."
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

/** Connect to (or disconnect from) an S3-compatible bucket through your Cadence server. */
export function S3Settings() {
  return (
    <>
      <ServerGate store={useS3} label="S3 storage">
        {(status) => (status.connected ? <Connected status={status} /> : <ConnectForm />)}
      </ServerGate>
      <div className="rs-root" style={{ marginTop: 16 }}>
        <NetworkSwitch store={useS3} />
      </div>
    </>
  );
}
