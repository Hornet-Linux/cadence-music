import { useEffect, useRef, useState } from "react";
import { describeError, useIsAdmin } from "../_sourcekit/api";
import { DownloadIcon, UploadIcon } from "../_sourcekit/icons";
import { Problem, SignInGate } from "../_sourcekit/ui";
import { describeImport, downloadOpml, readOpmlFile } from "./opml";
import { importOpml, podcastAdmin, savePodcastAdmin, usePodcasts } from "./podcastStore";

function AdminKeys() {
  const [state, setState] = useState<{ configured: boolean; key: string | null } | null>(null);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    void podcastAdmin()
      .then((a) => setState({ configured: a.podcastIndexConfigured, key: a.podcastIndexKey }))
      .catch((e: unknown) => setMsg({ text: describeError(e, "podcasts"), error: true }));
  }, []);
  async function save(clear: boolean) {
    setMsg(null);
    try {
      const res = await savePodcastAdmin(clear ? { podcastIndexKey: null } : { podcastIndexKey: key.trim(), podcastIndexSecret: secret.trim() });
      setState({ configured: res.podcastIndexConfigured, key: res.podcastIndexKey });
      setKey("");
      setSecret("");
      setMsg({ text: clear ? "Back to the free iTunes directory." : "Saved. Searches now use Podcast Index.", error: false });
    } catch (e) {
      setMsg({ text: describeError(e, "podcasts"), error: true });
    }
  }
  return (
    <div className="stack">
      <p className="strong">Directory (server owner)</p>
      <p className="muted small">
        Search uses Apple&apos;s free iTunes directory. If you have a Podcast Index API key and secret (free at podcastindex.org), add them here to use that directory instead. The secret is stored encrypted and never shown again.
      </p>
      <p className="muted small">{state?.configured ? `Podcast Index is on (key ${state.key}).` : "Podcast Index is off."}</p>
      <div className="sk-form">
        <input className="sk-field" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Podcast Index API key" autoCapitalize="off" autoCorrect="off" />
        <input className="sk-field" type="password" placeholder="API secret" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Podcast Index API secret" autoComplete="off" />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn" style={{ minHeight: 44 }} disabled={!key.trim() || !secret.trim()} onClick={() => void save(false)}>
          Save keys
        </button>
        {state?.configured && (
          <button className="btn ghost" style={{ minHeight: 44 }} onClick={() => void save(true)}>
            Remove keys
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

export function PodcastSettings() {
  const refresh = usePodcasts((s) => s.refresh);
  const loadShows = usePodcasts((s) => s.loadShows);
  const isAdmin = useIsAdmin();
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(task: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ text: await task(), error: false });
    } catch (e) {
      setMsg({ text: describeError(e, "podcasts"), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SignInGate what="Podcasts">
      <div className="stack">
        <p className="muted small">Your subscriptions, listening progress and each show&apos;s speed are saved on your server, so they follow you to every device.</p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn"
            style={{ minHeight: 44 }}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await refresh();
                return r ? (r.newEpisodes ? `${r.newEpisodes} new episode${r.newEpisodes === 1 ? "" : "s"}.` : "You're up to date.") : "Couldn't check right now.";
              })
            }
          >
            Check for new episodes
          </button>
          <button
            className="btn ghost"
            style={{ minHeight: 44 }}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await downloadOpml();
                return "Saved your subscriptions as an OPML file.";
              })
            }
          >
            <DownloadIcon size={16} /> Export OPML
          </button>
          <button className="btn ghost" style={{ minHeight: 44 }} disabled={busy} onClick={() => file.current?.click()}>
            <UploadIcon size={16} /> Import OPML
          </button>
          <input
            ref={file}
            type="file"
            accept=".opml,.xml,text/xml,application/xml,text/x-opml"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              void run(async () => {
                const result = describeImport(await importOpml(await readOpmlFile(f)));
                void loadShows();
                return result;
              });
            }}
          />
        </div>
        {msg && (
          <p className={msg.error ? "notice error" : "muted small"} role={msg.error ? "alert" : "status"}>
            {msg.text}
          </p>
        )}
        <Problem message={null} />
        {isAdmin && <AdminKeys />}
      </div>
    </SignInGate>
  );
}