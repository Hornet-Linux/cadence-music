import { useCallback, useEffect } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { useServer } from "../../builtins/server/serverStore";
import { AdminAddress, type AddressInfo, type TestResult } from "../sourcesCommon/AdminAddress";
import "../sourcesCommon/style.css";
import { usePlex } from "./plexStore";

const POLL_MS = 3000;

function OwnerAddress() {
  const refresh = usePlex((s) => s.refresh);
  const api = useServer.getState().api;
  const load = useCallback(() => useServer.getState().api<AddressInfo>("api/admin/plex"), []);
  const save = useCallback((url: string | null) => api<AddressInfo>("api/admin/plex", { method: "PUT", body: JSON.stringify({ serverUrl: url }) }), [api]);
  const test = useCallback((url: string) => api<TestResult>("api/admin/plex/test", { method: "POST", body: JSON.stringify({ serverUrl: url }) }), [api]);
  return (
    <div className="stack">
      <p className="strong">Server owner</p>
      <AdminAddress label="Plex" example="http://plex:32400" load={load} save={save} test={test} onChanged={() => void refresh()} />
    </div>
  );
}

/** While a link code is open, ask the server every few seconds whether it has been entered. */
function useLinkPolling(open: boolean) {
  const pollLink = usePlex((s) => s.pollLink);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void pollLink(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, pollLink]);
}

/** Link your own Plex account (a code you enter at plex.tv/link), then pick a music library. */
export function PlexSettings() {
  const { status, checking, busy, error, link, linkState, libraries, startLink, cancelLink, disconnect, refresh, chooseLibrary, loadLibraries } = usePlex();
  const serverUser = useServer((s) => s.user);
  const openSettings = useSettingsModal((s) => s.show);
  useLinkPolling(!!link);

  const needsLibrary = !!status?.connected && !status.library;
  useEffect(() => {
    if (needsLibrary) void loadLibraries();
  }, [needsLibrary, loadLibraries]);

  if (!serverUser) {
    return (
      <div className="stack">
        <p className="muted small">
          Plex connects through your Cadence server, so sign in to the server first. Your server owner chooses which Plex server it uses; you only need
          a Plex account that has access to it.
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
        <p className="muted small">{checking ? "Checking Plex…" : "Couldn't check Plex."}</p>
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
          {serverUser.isAdmin ? "Plex isn't set up yet. Add your Plex server's address below." : "Plex isn't set up on this server. Ask the server owner to add its address."}
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
            <div className="strong">{status.userName ?? "Plex"}</div>
            <div className="muted small">
              {status.serverName ? `On ${status.serverName}` : "Linked"}
              {status.library ? ` · ${status.library.title}` : ""}
            </div>
          </div>
          <div className="row">
            <button className="btn ghost" disabled={busy} onClick={() => void disconnect()}>
              Unlink
            </button>
          </div>
        </div>
        {needsLibrary && (
          <div className="stack">
            <p className="strong">Choose a music library</p>
            {libraries.length === 0 ? (
              <p className="muted small">Looking for music libraries…</p>
            ) : (
              <div className="src-actions">
                {libraries.map((l) => (
                  <button key={l.key} className="btn" disabled={busy} onClick={() => void chooseLibrary(l.key)}>
                    {l.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!needsLibrary && libraries.length > 1 && null}
        {error && <p className="notice error">{error}</p>}
        <p className="muted small">To fully remove Cadence, also remove it from your authorized devices on plex.tv.</p>
        {owner}
      </div>
    );
  }

  return (
    <div className="stack src-form">
      {link ? (
        <>
          <p className="muted small">
            On any device, open{" "}
            <a href={link.linkUrl} target="_blank" rel="noreferrer">
              {link.linkUrl.replace(/^https?:\/\//, "")}
            </a>
            , sign in to Plex and enter this code. This page notices on its own.
          </p>
          <div className="src-code" aria-label={`Plex code ${link.code.split("").join(" ")}`}>
            {link.code}
          </div>
          <p className="muted small" aria-live="polite">
            Waiting for you to enter the code…
          </p>
          <div>
            <button className="btn ghost" onClick={cancelLink}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            Link your own Plex account to browse and play your music here. Plex gives Cadence a code to enter at plex.tv/link; your Plex password never
            reaches Cadence.
          </p>
          {linkState === "expired" && <p className="notice">That code expired. Get a new one.</p>}
          {linkState === "no_access" && <p className="notice error">That Plex account doesn&apos;t have access to this server. Ask the owner to share it with you.</p>}
          {error && <p className="notice error">{error}</p>}
          <div>
            <button className="btn primary" disabled={busy} onClick={() => void startLink()}>
              {busy ? "Getting a code…" : "Link Plex account"}
            </button>
          </div>
        </>
      )}
      {owner}
    </div>
  );
}