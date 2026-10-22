import { useState } from "react";
import { Toggle, SettingRow } from "@/features/settings/controls";
import { Code, Help, StatusLine } from "../_desktop/panel";
import { isApplicationId } from "./presence";
import { presenceSettings, useDiscordStatus } from "./store";

function statusLine(state: string, user?: string, error?: string) {
  switch (state) {
    case "connected":
      return <StatusLine tone="ok">Connected to Discord{user ? ` as ${user}` : ""}</StatusLine>;
    case "connecting":
      return <StatusLine tone="warn">Connecting to Discord...</StatusLine>;
    case "waiting":
      return (
        <StatusLine tone="warn">
          {error ?? "Waiting for Discord"}. Open the Discord app; Cadence keeps trying.
        </StatusLine>
      );
    default:
      return <StatusLine tone="off">{error ?? "Not connected"}</StatusLine>;
  }
}

export function DiscordSettings() {
  const values = presenceSettings.useSettings((s) => s.values);
  const set = presenceSettings.useSettings((s) => s.set);
  const status = useDiscordStatus((s) => s.status);
  const [draft, setDraft] = useState(values.applicationId);
  const valid = isApplicationId(draft);
  const dirty = draft.trim() !== values.applicationId;

  return (
    <>
      <div className="di-stack">
        <div>
          <label className="field-label" htmlFor="discord-app-id">
            Discord application ID
          </label>
          <div className="di-row">
            <input
              id="discord-app-id"
              className="text-input"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. 123456789012345678"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              className="btn primary di-btn"
              disabled={!dirty || (draft.trim() !== "" && !valid)}
              onClick={() => set({ applicationId: draft.trim() })}
            >
              {draft.trim() === "" && values.applicationId ? "Remove" : "Save"}
            </button>
          </div>
          {draft.trim() !== "" && !valid && <p className="di-note">An application ID is a number with 17 to 20 digits.</p>}
        </div>
        {values.applicationId ? statusLine(status.state, status.user, status.error) : <StatusLine tone="off">Add an application ID to start</StatusLine>}
      </div>

      <SettingRow title="Private mode" description="Share nothing, without turning the plugin off. Your activity is removed from Discord right away.">
        <Toggle label="Private mode" on={values.private} onChange={(v) => set({ private: v })} />
      </SettingRow>
      <SettingRow title="Cover art" description="Show the album cover when it has a public web address. Covers served only to you (such as from your own server) are never sent.">
        <Toggle label="Show cover art" on={values.showArtwork} onChange={(v) => set({ showArtwork: v })} />
      </SettingRow>
      <SettingRow title="Album name" description="Show the album when you hover the cover.">
        <Toggle label="Show album name" on={values.showAlbum} onChange={(v) => set({ showAlbum: v })} />
      </SettingRow>
      <SettingRow title="Hide when paused" description="Remove the activity while playback is paused, instead of showing Paused.">
        <Toggle label="Hide when paused" on={values.hideWhenPaused} onChange={(v) => set({ hideWhenPaused: v })} />
      </SettingRow>

      <div className="di-stack">
        <Help title="How to get an application ID">
          <ol>
            <li>
              Open <Code>discord.com/developers/applications</Code> in your browser and sign in.
            </li>
            <li>
              Choose <strong>New Application</strong>. The name you pick is what friends see: &quot;Listening to <em>Cadence</em>&quot;.
            </li>
            <li>
              On <strong>General Information</strong>, copy the <strong>Application ID</strong> and paste it above.
            </li>
          </ol>
          <p>
            You do not need to upload any images or turn anything else on. Cadence sends the cover by its web address.
            Discord must be the desktop app, running on this computer, with <strong>Settings &gt; Activity Privacy &gt; Share
            my activity</strong> on.
          </p>
        </Help>
        <p className="di-note">
          Cadence shares the track title, artists, album, a public cover link and the time elapsed with Discord, on this
          computer only. Nothing is sent to any other service, and the activity is cleared when you pause (if you chose
          that), turn on private mode, turn this plugin off or quit.
        </p>
      </div>
    </>
  );
}