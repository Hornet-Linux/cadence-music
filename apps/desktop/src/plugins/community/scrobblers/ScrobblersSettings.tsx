import { useEffect, useState } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "../../builtins/server/serverStore";
import {
  DEFAULT_LB_HOST,
  SERVICE_BLURB,
  queueLine,
  relativeTime,
  summarize,
  validListenBrainzToken,
  validServiceAddress,
  type ServiceStatus,
  friendlyError,
} from "./logic";
import { useScrobblers } from "./scrobblersStore";

const REFRESH_MS = 15_000;

function Dot({ tone }: { tone: "ok" | "warn" | "off" | "error" }) {
  return <span className={`scrb-dot ${tone}`} aria-hidden="true" />;
}

function Feedback({ id }: { id: ServiceStatus["id"] }) {
  const message = useScrobblers((s) => s.messages[id]);
  if (!message) return null;
  return (
    <p
      className={message.kind === "error" ? "notice error" : "notice"}
      role={message.kind === "error" ? "alert" : "status"}
    >
      {message.text}
    </p>
  );
}

function ConnectForm({
  service,
  customHosts,
}: {
  service: ServiceStatus;
  customHosts: boolean;
}) {
  const {
    busy,
    approvals,
    startApproval,
    finishApproval,
    connectListenBrainz,
    connectMaloja,
  } = useScrobblers();
  const [token, setToken] = useState("");
  const [host, setHost] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const working = !!busy[service.id];

  if (service.id === "lastfm" || service.id === "librefm") {
    const approveUrl = approvals[service.id];
    if (approveUrl || service.awaitingApproval) {
      return (
        <div className="scrb-steps">
          <p className="muted small">
            Two quick steps. {service.label} asks you to approve Cadence, then
            you come back and finish.
          </p>
          <div className="scrb-actions">
            {approveUrl ? (
              <a
                className="btn"
                href={approveUrl}
                target="_blank"
                rel="noreferrer"
              >
                1. Open {service.label}
              </a>
            ) : (
              <button
                className="btn"
                disabled={working}
                onClick={() => void startApproval(service.id)}
              >
                1. Get a new link
              </button>
            )}
            <button
              className="btn primary"
              disabled={working}
              onClick={() => void finishApproval(service.id)}
            >
              {busy[service.id] === "finish" ? "Finishing…" : "2. Finish"}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="scrb-actions">
        <button
          className="btn primary"
          disabled={working}
          onClick={() => void startApproval(service.id)}
        >
          {busy[service.id] === "connect"
            ? "Contacting…"
            : `Connect ${service.label}`}
        </button>
      </div>
    );
  }

  if (service.id === "listenbrainz") {
    const ready =
      validListenBrainzToken(token) &&
      (!host.trim() || validServiceAddress(host));
    return (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void connectListenBrainz(token, host).then(
            (ok) => ok && setToken(""),
          );
        }}
      >
        <div>
          <label className="field-label" htmlFor="scrb-lb-token">
            User token
          </label>
          <input
            id="scrb-lb-token"
            className="text-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste from listenbrainz.org/settings"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        {customHosts && (
          <div>
            <label className="field-label" htmlFor="scrb-lb-host">
              Your own server (optional)
            </label>
            <input
              id="scrb-lb-host"
              className="text-input"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={DEFAULT_LB_HOST}
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          </div>
        )}
        <div>
          <button
            className="btn primary"
            type="submit"
            disabled={!ready || working}
          >
            {working ? "Checking…" : "Connect ListenBrainz"}
          </button>
        </div>
      </form>
    );
  }

  // Maloja
  const ready = validServiceAddress(url) && key.trim().length > 0;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void connectMaloja(url, key).then((ok) => ok && setKey(""));
      }}
    >
      <div>
        <label className="field-label" htmlFor="scrb-mj-url">
          Maloja address
        </label>
        <input
          id="scrb-mj-url"
          className="text-input"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://maloja.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="scrb-mj-key">
          API key
        </label>
        <input
          id="scrb-mj-key"
          className="text-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div>
        <button
          className="btn primary"
          type="submit"
          disabled={!ready || working}
        >
          {working ? "Checking…" : "Connect Maloja"}
        </button>
      </div>
    </form>
  );
}

function ServiceCard({
  service,
  now,
  isAdmin,
}: {
  service: ServiceStatus;
  now: number;
  isAdmin: boolean;
}) {
  const { busy, setEnabled, test, disconnect, retryNow, clearQueue } =
    useScrobblers();
  const customHosts = useScrobblers(
    (s) => s.status?.customHostsAllowed ?? false,
  );
  const summary = summarize(service);
  const working = !!busy[service.id];
  const pending = service.queue.pending;

  return (
    <section className="scrb-card" aria-label={service.label}>
      <header className="scrb-head">
        <div className="scrb-title">
          <Dot tone={summary.tone} />
          <h3>{service.label}</h3>
        </div>
        <span className="scrb-state muted small">{summary.label}</span>
      </header>

      {!service.connected && (
        <p className="muted small">{SERVICE_BLURB[service.id]}</p>
      )}

      {service.connected ? (
        <div className="scrb-body">
          <dl className="scrb-facts small">
            {service.username && (
              <div>
                <dt>Account</dt>
                <dd>{service.username}</dd>
              </div>
            )}
            {service.host && (
              <div>
                <dt>Address</dt>
                <dd>{service.host}</dd>
              </div>
            )}
            <div>
              <dt>Last sent</dt>
              <dd>
                {service.lastSuccessAt
                  ? relativeTime(service.lastSuccessAt, now)
                  : "Nothing yet"}
              </dd>
            </div>
            <div>
              <dt>Queue</dt>
              <dd>{queueLine(service.queue, now)}</dd>
            </div>
          </dl>
          {service.lastError && (
            <p className={service.needsReauth ? "notice error" : "notice warn"}>
              {friendlyError(
                service.lastError.message,
                service.label,
                pending > 0,
              )}{" "}
              <span className="muted">
                ({relativeTime(service.lastError.at, now)})
              </span>
              {service.needsReauth &&
                " Disconnect and connect again to fix it."}
            </p>
          )}
          <div className="scrb-actions">
            <button
              className="btn"
              disabled={working}
              onClick={() => void setEnabled(service.id, !service.enabled)}
            >
              {service.enabled ? "Pause" : "Resume"}
            </button>
            <button
              className="btn"
              disabled={working}
              onClick={() => void test(service.id)}
            >
              {busy[service.id] === "test" ? "Testing…" : "Test connection"}
            </button>
            {pending > 0 && (
              <button
                className="btn"
                disabled={working}
                onClick={() => void retryNow(service.id)}
              >
                Retry now
              </button>
            )}
            {pending > 0 && (
              <button
                className="btn ghost"
                disabled={working}
                onClick={() => void clearQueue(service.id)}
              >
                Clear queue
              </button>
            )}
            <button
              className="btn ghost"
              disabled={working}
              onClick={() => void disconnect(service.id)}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : service.available ? (
        <ConnectForm service={service} customHosts={customHosts} />
      ) : (
        <p className="muted small">
          {service.unavailableReason}
          {isAdmin && " You can set this up under Server owner below."}
        </p>
      )}
      <Feedback id={service.id} />
    </section>
  );
}

function OwnerSection() {
  const { admin, status, loadAdmin, saveAdmin } = useScrobblers();
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadAdmin();
  }, [loadAdmin]);
  useEffect(() => {
    if (admin?.lastfm) setApiKey(admin.lastfm.apiKey);
  }, [admin?.lastfm]);

  if (!admin) return null;
  const hasKeys = !!admin.lastfm;

  return (
    <details className="scrb-owner">
      <summary>Server owner</summary>
      <div className="stack">
        <p className="muted small">
          Last.fm needs an API account from you:{" "}
          <a
            href="https://www.last.fm/api/account/create"
            target="_blank"
            rel="noreferrer"
          >
            create one at last.fm/api
          </a>{" "}
          and paste its key and shared secret. The secret is stored encrypted
          and never shown again.
        </p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(false);
            void saveAdmin({
              lastfm: { apiKey, ...(apiSecret ? { apiSecret } : {}) },
            }).then((ok) => {
              if (ok) {
                setApiSecret("");
                setSaved(true);
              }
            });
          }}
        >
          <div>
            <label className="field-label" htmlFor="scrb-admin-key">
              Last.fm API key
            </label>
            <input
              id="scrb-admin-key"
              className="text-input"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="scrb-admin-secret">
              Shared secret {hasKeys && "(saved; leave empty to keep it)"}
            </label>
            <input
              id="scrb-admin-secret"
              className="text-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
            />
          </div>
          <div className="scrb-actions">
            <button
              className="btn primary"
              type="submit"
              disabled={!apiKey.trim() || (!hasKeys && !apiSecret.trim())}
            >
              Save Last.fm keys
            </button>
            {hasKeys && (
              <button
                className="btn ghost"
                type="button"
                onClick={() => void saveAdmin({ lastfm: null })}
              >
                Remove
              </button>
            )}
          </div>
          {saved && <p className="notice">Saved.</p>}
        </form>
        <label className="scrb-check">
          <input
            type="checkbox"
            checked={admin.allowCustomHosts}
            onChange={(e) =>
              void saveAdmin({ allowCustomHosts: e.target.checked })
            }
          />
          <span>
            Let people connect their own servers (Maloja, self-hosted
            ListenBrainz)
            <span className="muted small">
              {" "}
              This makes the server contact addresses people type in. Turn it on
              only if you trust your users.
            </span>
          </span>
        </label>
        {status && (
          <p className="muted small">
            Failed plays are retried for {status.retryDays} days, then given up
            on.
          </p>
        )}
      </div>
    </details>
  );
}

/** Settings panel: connect scrobbling services, see their queue and last error. */
export function ScrobblersSettings() {
  const user = useServer((s) => s.user);
  const token = useServer((s) => s.token);
  const openSettings = useSettingsModal((s) => s.show);
  const { status, support, loading, error, refresh } = useScrobblers();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!token) return;
    void refresh().then(() => setNow(Date.now()));
    const timer = setInterval(() => {
      void refresh().then(() => setNow(Date.now()));
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [token, refresh]);

  if (!user) {
    return (
      <div className="stack scrb">
        <p className="muted small">
          Scrobbling runs on your Cadence server, so it works only once
          you&apos;re signed in to one.
        </p>
        <div>
          <button className="btn" onClick={() => openSettings("server")}>
            Open server settings
          </button>
        </div>
      </div>
    );
  }

  if (support === "missing") {
    return (
      <div className="stack scrb">
        <p className="notice">
          This server doesn&apos;t have scrobbling turned on. The server owner
          can enable the Scrobblers plugin in the server settings and restart
          it.
        </p>
        <div>
          <button
            className="btn ghost"
            disabled={loading}
            onClick={() => void refresh()}
          >
            Check again
          </button>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="stack scrb">
        <p className="muted small">
          {loading ? "Checking your server…" : "Couldn't check scrobbling."}
        </p>
        {error && <p className="notice error">{error}</p>}
        {!loading && (
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
    <div className="stack scrb">
      <p className="muted small">
        Your server sends every finished play to the services you connect, from
        any device, and retries if a service is down.
      </p>
      {error && <p className="notice error">{error}</p>}
      {status.services.map((service) => (
        <ServiceCard
          key={service.id}
          service={service}
          now={now}
          isAdmin={status.isAdmin}
        />
      ))}
      {status.problems.length > 0 && (
        <div className="scrb-problems">
          <h4>Recent problems</h4>
          <ul>
            {status.problems.map((p, i) => (
              <li key={`${p.service}-${p.playedAt}-${i}`} className="small">
                <span className="strong">{p.title}</span>{" "}
                <span className="muted">· {p.artist}</span>
                <div className="muted">
                  {p.service} ·{" "}
                  {p.state === "dropped" ? "given up" : "retrying"}
                  {p.error ? ` · ${p.error}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {status.isAdmin && <OwnerSection />}
    </div>
  );
}
