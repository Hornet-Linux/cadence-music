import { useCallback, useEffect, useState } from "react";
import { useServer } from "../../builtins/server/serverStore";
import type { MetadataClient } from "../_metadata/client";
import { saveAdminConfig } from "../_metadata/server";
import type { MetadataAdminConfig, MetadataStatus } from "../_metadata/types";
import type { PluginContext } from "../../types";
import "./style.css";

interface KeyField {
  field: "fanartApiKey" | "discogsToken" | "bandsintownAppId";
  provider: "fanart" | "discogs" | "bandsintown";
  label: string;
  what: string;
  help: { text: string; url: string };
}

const KEYS: KeyField[] = [
  {
    field: "fanartApiKey",
    provider: "fanart",
    label: "Fanart.tv API key",
    what: "Artist photos and logos",
    help: { text: "Get a free key", url: "https://fanart.tv/get-an-api-key/" },
  },
  {
    field: "discogsToken",
    provider: "discogs",
    label: "Discogs token",
    what: "Artist profiles and release details (optional)",
    help: { text: "Create a personal token", url: "https://www.discogs.com/settings/developers" },
  },
  {
    field: "bandsintownAppId",
    provider: "bandsintown",
    label: "Bandsintown app id",
    what: "Upcoming concerts",
    help: { text: "About the Bandsintown API", url: "https://app.swaggerhub.com/apis/Bandsintown/PublicAPI/3.0.0" },
  },
];

const FREE = [
  ["MusicBrainz", "Artist, recording and release details; new releases"],
  ["Cover Art Archive", "Album covers"],
  ["Wikipedia and Wikidata", "Artist biographies"],
];

/** Which metadata services work on this server, and (for admins) where to put their keys. */
export function MetadataSettings({ client, ctx }: { client: MetadataClient; ctx: Pick<PluginContext, "fetch"> }) {
  const isAdmin = useServer((s) => s.user?.isAdmin === true);
  const signedIn = useServer((s) => s.user !== null);
  const [status, setStatus] = useState<MetadataStatus | null>(null);
  const [admin, setAdmin] = useState<MetadataAdminConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      client.forget();
      setStatus(await client.status());
      if (isAdmin) setAdmin(await client.adminConfig());
    } catch {
      setStatus(null);
    }
  }, [client, isAdmin]);

  useEffect(() => {
    if (signedIn) void refresh();
  }, [signedIn, refresh]);

  if (!signedIn) {
    return <p className="muted small">Sign in to your Cadence server first. These lookups run through it.</p>;
  }

  const save = async (body: Record<string, string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      await saveAdminConfig(ctx, body);
      setDraft({});
      setMessage({ kind: "ok", text: "Saved." });
      await refresh();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  };

  const filled = Object.fromEntries(Object.entries(draft).filter(([, v]) => v.trim().length > 0));

  return (
    <div className="stack metadata-settings">
      <p className="muted small">
        Cadence looks up artist details through your server, which keeps a cache and respects each service&apos;s limits. These
        work with no setup:
      </p>
      <ul className="metadata-free">
        {FREE.map(([name, what]) => (
          <li key={name}>
            <span className="status-dot online" aria-hidden /> <span className="strong">{name}</span>
            <span className="muted small"> {what}</span>
          </li>
        ))}
      </ul>
      {KEYS.map((k) => {
        const on = status?.providers[k.provider] === true;
        return (
          <div className="metadata-key" key={k.field}>
            <div className="metadata-key-head">
              <span className={"status-dot " + (on ? "online" : "offline")} aria-hidden />
              <span className="strong">{k.label}</span>
              <span className="muted small">{on ? "Set" : "Not set"}</span>
            </div>
            <div className="muted small">
              {k.what}.{" "}
              <a href={k.help.url} target="_blank" rel="noreferrer">
                {k.help.text}
              </a>
            </div>
            {isAdmin && (
              <div className="row metadata-key-row">
                <input
                  className="text-input"
                  type={k.field === "bandsintownAppId" ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={on ? "Replace the saved value" : "Paste it here"}
                  aria-label={k.label}
                  value={draft[k.field] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [k.field]: e.target.value })}
                />
                {on && (
                  <button className="btn ghost" disabled={busy} onClick={() => void save({ [k.field]: null })}>
                    Remove
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {isAdmin ? (
        <div>
          <button className="btn primary" disabled={busy || Object.keys(filled).length === 0} onClick={() => void save(filled)}>
            {busy ? "Saving…" : "Save keys"}
          </button>
        </div>
      ) : (
        <p className="muted small">Only a server admin can add or change keys.</p>
      )}
      {admin === null && isAdmin && status !== null && <p className="muted small">Could not read the saved settings.</p>}
      {message && <p className={"notice" + (message.kind === "error" ? " error" : "")}>{message.text}</p>}
    </div>
  );
}
