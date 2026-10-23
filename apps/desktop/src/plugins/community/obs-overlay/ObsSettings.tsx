import { useCallback, useEffect, useState } from "react";
import { Segmented, SettingRow, Toggle } from "@/features/settings/controls";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { Code, CopyButton, Help, StatusLine } from "../_desktop/panel";
import { overlayUrl, type OverlayOptions, type OverlayTheme } from "./overlay";
import { obsSettings, useObsState, type LinkInfo } from "./store";

const THEMES: { value: OverlayTheme; label: string }[] = [
  { value: "calm", label: "Calm dark" },
  { value: "light", label: "Soft light" },
  { value: "minimal", label: "Text only" },
  { value: "bar", label: "Bar" },
];

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "never");

export function ObsSettings() {
  const values = obsSettings.useSettings((s) => s.values);
  const set = obsSettings.useSettings((s) => s.set);
  const { links, sending, error } = useObsState();
  const user = useServer((s) => s.user);
  const serverUrl = useServer((s) => s.url);
  const api = useServer((s) => s.api);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ tokens: LinkInfo[] }>("api/now-playing/tokens");
      useObsState.setState({ links: res.tokens, error: null });
    } catch {
      useObsState.setState({
        links: null,
        error: "Your server does not have the Now playing overlay plugin turned on. An admin can enable it under Settings > Plugins on the server.",
      });
    }
  }, [api]);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  const opts = values.options;
  const setOpts = (patch: Partial<OverlayOptions>) => set({ options: { ...opts, ...patch } });
  const local = (id: number) => values.links.find((l) => l.id === id)?.token;

  if (!user) {
    return (
      <div className="di-stack">
        <StatusLine tone="warn">Sign in to your Cadence server first (Settings &gt; Server). Overlay links live on your server.</StatusLine>
      </div>
    );
  }

  const create = async () => {
    setBusy(true);
    try {
      const created = await api<{ id: number; token: string }>("api/now-playing/tokens", {
        method: "POST",
        body: JSON.stringify({ label: label.trim() || "Overlay" }),
      });
      set({ links: [...values.links, { id: created.id, token: created.token }] });
      setLabel("");
      await refresh();
    } catch {
      useObsState.setState({ error: "Could not create a link. You may already have the maximum of 10, or the plugin is off on the server." });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
    setBusy(true);
    try {
      await api(`api/now-playing/tokens/${id}`, { method: "DELETE" });
      set({ links: values.links.filter((l) => l.id !== id) });
      await refresh();
    } catch {
      useObsState.setState({ error: "Could not revoke that link. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow
        title="Send what I'm playing"
        description="This device tells your server the current song so your overlay links can show it. It is kept in the server's memory only and is never saved."
      >
        <Toggle label="Send what I'm playing" on={values.sendNowPlaying} onChange={(v) => set({ sendNowPlaying: v })} />
      </SettingRow>
      {values.sendNowPlaying && sending && (
        <div className="di-stack">
          <StatusLine tone={sending.tone}>{sending.text}</StatusLine>
        </div>
      )}

      <div className="di-stack">
        <div className="setting-title">Look</div>
        <Segmented label="Overlay theme" value={opts.theme} options={THEMES} onChange={(theme) => setOpts({ theme })} />
        <div className="di-row">
          <Segmented
            label="Overlay position"
            value={opts.align}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
            onChange={(align) => setOpts({ align })}
          />
          <Segmented
            label="Overlay size"
            value={String(opts.scale)}
            options={[
              { value: "0.75", label: "Small" },
              { value: "1", label: "Normal" },
              { value: "1.5", label: "Large" },
            ]}
            onChange={(v) => setOpts({ scale: Number(v) })}
          />
        </div>
      </div>
      <SettingRow title="Cover art" description="Shown only when the song has a public cover image.">
        <Toggle label="Cover art" on={opts.showArt} onChange={(v) => setOpts({ showArt: v })} />
      </SettingRow>
      <SettingRow title="Progress bar">
        <Toggle label="Progress bar" on={opts.showProgress} onChange={(v) => setOpts({ showProgress: v })} />
      </SettingRow>

      <div className="di-stack">
        <div className="setting-title">Overlay links</div>
        {error && <StatusLine tone="warn">{error}</StatusLine>}
        <div className="di-table">
          {(links ?? []).map((l) => {
            const token = local(l.id);
            const url = token ? overlayUrl(serverUrl, token, opts) : null;
            return (
              <div className="di-item" key={l.id}>
                <div className="di-item-main">
                  <div className="di-item-title">{l.label}</div>
                  <div className="di-item-sub">
                    Created {when(l.createdAt)}, last opened {when(l.lastUsedAt)}
                    {l.viewers > 0 ? `, ${l.viewers} open now` : ""}
                  </div>
                  {!url && <div className="di-item-sub">Made on another device, so its address cannot be shown here. Revoke it and make a new one.</div>}
                </div>
                {url && <CopyButton text={url} label="Copy link" />}
                <button className="btn ghost di-btn" disabled={busy} onClick={() => void revoke(l.id)}>
                  Revoke
                </button>
              </div>
            );
          })}
          {links && links.length === 0 && <p className="di-note">No links yet.</p>}
        </div>
        <div className="di-row">
          <input
            className="text-input"
            aria-label="Name for the new link"
            placeholder="Name, e.g. Stream"
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button className="btn primary di-btn" disabled={busy} onClick={() => void create()}>
            Create link
          </button>
        </div>
        <p className="di-note">
          Anyone with a link can see what you are playing, so treat it like a password and only paste it into OBS. Revoke a link to stop it
          working at once. The server keeps only a scrambled copy of each link, so its address is kept on this device to copy again.
        </p>
        <Help title="How to add it to OBS">
          <ol>
            <li>
              In OBS, under <strong>Sources</strong> choose <strong>+</strong>, then <strong>Browser</strong>.
            </li>
            <li>Paste the link into <strong>URL</strong>. Set width 600 and height 160 (or to match the size you chose).</li>
            <li>
              Leave <strong>Custom CSS</strong> as it is: the background is already see-through. Tick <strong>Shutdown source when not visible</strong> if you like.
            </li>
            <li>Press OK. Play a song in Cadence and it appears within a second or two.</li>
          </ol>
          <p>
            The page is <Code>/overlay/your-link</Code> on your server, updates live, and works in any browser too. Use Create link again for a
            different scene with its own look.
          </p>
        </Help>
      </div>
    </>
  );
}