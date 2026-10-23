import { useEffect, useState } from "react";
import { SettingRow, Toggle } from "@/features/settings/controls";
import { SLACK_TOKEN_RE } from "../../../../electron/slack";
import { desktopBridge } from "../_desktop/desktop";
import { Code, Help, StatusLine } from "../_desktop/panel";
import { formatStatusText, isValidEmoji } from "./format";
import { SLACK_SECRET_KEY, statusSettings, useStatusState } from "./store";

const SAMPLE = {
  id: "sample",
  title: "Teardrop",
  artists: [{ id: "a", name: "Massive Attack" }],
  album: "Mezzanine",
};

export function StatusSyncSettings() {
  const values = statusSettings.useSettings((s) => s.values);
  const set = statusSettings.useSettings((s) => s.set);
  const { hasToken, message } = useStatusState();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const bridge = desktopBridge();

  useEffect(() => {
    void window.host.secrets
      .get(SLACK_SECRET_KEY)
      .then((t) => useStatusState.setState({ hasToken: !!t }))
      .catch(() => useStatusState.setState({ hasToken: false }));
  }, []);

  const tokenOk = SLACK_TOKEN_RE.test(token.trim());
  const saveToken = async () => {
    if (!bridge || !tokenOk) return;
    setBusy(true);
    try {
      await window.host.secrets.set(SLACK_SECRET_KEY, token.trim());
      setToken("");
      useStatusState.setState({ hasToken: true });
      const result = await bridge.slack.test();
      useStatusState.setState({
        message: result.ok
          ? { tone: "ok", text: `Connected${result.user ? ` as ${result.user}` : ""}${result.team ? ` in ${result.team}` : ""}` }
          : { tone: "warn", text: `Slack said: ${result.error}` },
      });
    } catch {
      useStatusState.setState({ message: { tone: "warn", text: "Could not save the token (is secure storage available?)" } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="di-stack">
        <div>
          <label className="field-label" htmlFor="slack-token">
            Slack user token
          </label>
          <div className="di-row">
            <input
              id="slack-token"
              className="text-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={hasToken ? "A token is saved. Paste a new one to replace it." : "xoxp-..."}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button className="btn primary di-btn" disabled={!tokenOk || busy} onClick={() => void saveToken()}>
              Save
            </button>
            {hasToken && (
              <button
                className="btn ghost di-btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void bridge?.slack
                    .test()
                    .then((r) =>
                      useStatusState.setState({
                        message: r.ok ? { tone: "ok", text: "The token works" } : { tone: "warn", text: `Slack said: ${r.error}` },
                      }),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Test
              </button>
            )}
            {hasToken && (
              <button
                className="btn ghost di-btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void bridge?.slack
                    .forget()
                    .then(() => useStatusState.setState({ hasToken: false, message: null, active: false }))
                    .finally(() => setBusy(false));
                }}
              >
                Remove
              </button>
            )}
          </div>
          {token !== "" && !tokenOk && <p className="di-note">A Slack user token starts with xoxp-.</p>}
          <p className="di-note">
            The token is stored encrypted by your operating system and is only ever used by the desktop app to call Slack.
          </p>
        </div>
        {message ? (
          <StatusLine tone={message.tone}>{message.text}</StatusLine>
        ) : (
          <StatusLine tone="off">{hasToken ? "Token saved" : "No token yet"}</StatusLine>
        )}
      </div>

      <SettingRow
        title="Show my song in Slack"
        description="Off until you turn it on. While on, your Slack status shows what is playing and goes away when you pause or quit."
      >
        <Toggle label="Show my song in Slack" on={values.enabled} onChange={(v) => set({ enabled: v })} />
      </SettingRow>
      <SettingRow title="Clear when paused" description="Remove the status as soon as playback pauses.">
        <Toggle label="Clear when paused" on={values.clearOnPause} onChange={(v) => set({ clearOnPause: v })} />
      </SettingRow>
      <SettingRow title="Keep the song private" description={`Show only "Listening to music", not what you are playing.`}>
        <Toggle label="Keep the song private" on={values.hideTitle} onChange={(v) => set({ hideTitle: v })} />
      </SettingRow>

      <div className="di-stack">
        <div className="di-row">
          <div style={{ flex: "2 1 240px" }}>
            <label className="field-label" htmlFor="status-template">
              Status text
            </label>
            <input
              id="status-template"
              className="text-input"
              value={values.template}
              onChange={(e) => set({ template: e.target.value })}
              maxLength={120}
            />
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <label className="field-label" htmlFor="status-emoji">
              Emoji
            </label>
            <input
              id="status-emoji"
              className="text-input"
              value={values.emoji}
              onChange={(e) => set({ emoji: e.target.value.trim() })}
              aria-invalid={!isValidEmoji(values.emoji)}
            />
          </div>
        </div>
        <p className="di-note">
          Use <Code>{"{title}"}</Code>, <Code>{"{artist}"}</Code> and <Code>{"{album}"}</Code>. Slack shows up to 100 characters.
          {!isValidEmoji(values.emoji) && " The emoji should look like :headphones:, so :headphones: is used instead."}
        </p>
        <div className="di-block">
          <pre>
            {isValidEmoji(values.emoji) ? values.emoji : ":headphones:"} {formatStatusText(values.template, SAMPLE, values.hideTitle)}
          </pre>
        </div>
      </div>

      <div className="di-stack">
        <Help title="How to get a Slack token">
          <ol>
            <li>
              Go to <Code>api.slack.com/apps</Code> and choose <strong>Create New App</strong>, then <strong>From scratch</strong>. Pick your
              workspace.
            </li>
            <li>
              Open <strong>OAuth &amp; Permissions</strong>. Under <strong>User Token Scopes</strong> add <Code>users.profile:write</Code> (and{" "}
              <Code>users.profile:read</Code> if you want).
            </li>
            <li>
              Click <strong>Install to Workspace</strong> and allow it. Your workspace may need an admin to approve it.
            </li>
            <li>
              Copy the <strong>User OAuth Token</strong> (it starts with <Code>xoxp-</Code>) and paste it above.
            </li>
          </ol>
          <p>
            Cadence calls Slack&apos;s official <Code>users.profile.set</Code> method. Each status expires on its own shortly after the song
            should end, so it clears even if the computer crashes.
          </p>
        </Help>
        <Help title="Why not Microsoft Teams?">
          <p>
            Teams has no simple, supported way to do this. Microsoft&apos;s official route is the Graph presence API, which needs an
            Azure app registration and a sign-in flow with admin consent, and setting a custom status message there is still in its
            preview (beta) API. Cadence does not ship something that unreliable, so Teams is not included.
          </p>
        </Help>
      </div>
    </>
  );
}