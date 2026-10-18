import { useServer } from "../server/serverStore";
import { useSpotify } from "./spotifyStore";

export function SpotifySettings() {
  const s = useSpotify();
  const serverClientId = useServer((st) => st.integrations?.spotify?.clientId ?? null);
  const clientId = s.clientId || serverClientId || "";

  if (s.status === "signed-in") {
    return (
      <div className="stack">
        <div className="signed-in">
          <div>
            <div className="strong">{s.profile?.name ?? "Spotify"}</div>
            <div className="muted small">
              {s.profile ? (s.profile.premium ? "Premium" : "Free account") : "Connected"} ·{" "}
              {s.loading ? `loading… ${s.tracks.length}` : `${s.tracks.length} liked songs`}
            </div>
          </div>
          <div className="row">
            <button className="btn ghost" disabled={s.loading} onClick={() => void s.loadLibrary()}>
              Reload
            </button>
            <button className="btn ghost" onClick={() => void s.logout()}>
              Disconnect
            </button>
          </div>
        </div>
        {s.profile && !s.profile.premium && (
          <p className="notice warn">
            Spotify only allows playback in other apps for Premium accounts. Your library still
            shows up, but these tracks won't play.
          </p>
        )}
        {s.error && <p className="notice error">{s.error}</p>}
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="muted small">
        Connect your Spotify account to bring in your liked songs and play them here (Premium
        required for playback).
        {serverClientId
          ? " Your server already provides a Spotify app ID."
          : " You'll need a free Spotify developer app:"}
      </p>
      {!serverClientId && (
        <ol className="steps">
          <li>
            Open the Spotify developer dashboard (developer.spotify.com/dashboard) and create an
            app.
          </li>
          <li>
            Add the redirect URI <code>{s.redirectUri}</code> and tick <strong>Web API</strong> and{" "}
            <strong>Web Playback SDK</strong>.
          </li>
          <li>
            Under <strong>User Management</strong>, add the email address of every Spotify
            account that will use it.
          </li>
          <li>Paste the app's Client ID below.</li>
        </ol>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          s.setClientId(clientId);
          void s.login();
        }}
      >
        <input
          className="text-input"
          placeholder="Spotify Client ID"
          value={clientId}
          onChange={(e) => s.setClientId(e.target.value)}
          aria-label="Spotify Client ID"
          spellCheck={false}
        />
        <button className="btn primary" type="submit" disabled={s.status === "connecting" || !clientId.trim()}>
          {s.status === "connecting" ? "Waiting for browser…" : "Connect Spotify"}
        </button>
      </form>
      {s.error && <p className="notice error">{s.error}</p>}
    </div>
  );
}
