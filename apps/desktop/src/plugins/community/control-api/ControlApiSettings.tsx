import { useEffect, useState } from "react";
import { SettingRow, Toggle } from "@/features/settings/controls";
import { desktopBridge } from "../_desktop/desktop";
import { Code, CodeBlock, CopyButton, Help, StatusLine } from "../_desktop/panel";
import { describeMapping } from "./midi";
import { DEFAULT_PORT, controlSettings, useControlInfo, useMidiState } from "./store";

const COMMANDS: [string, string][] = [
  ["play", "Start playing"],
  ["pause", "Pause"],
  ["play-pause", "Play or pause"],
  ["next / previous", "Skip tracks"],
  ["volume-up / volume-down", "Change volume by 5%"],
  ["volume?value=0.4", "Set volume (0 to 1, or 0 to 100)"],
  ["seek?seconds=30", "Jump to a time in the song"],
  ["like / unlike / toggle-like", "The current song"],
];

export function ControlApiSettings({ names }: { names: () => string[] }) {
  const settings = controlSettings.useSettings((s) => s.values);
  const set = controlSettings.useSettings((s) => s.set);
  const info = useControlInfo((s) => s.info);
  const midi = useMidiState();
  const [reveal, setReveal] = useState(false);
  const [portDraft, setPortDraft] = useState(String(settings.port));
  const [busy, setBusy] = useState(false);
  const [learnTarget, setLearnTarget] = useState("next");
  const bridge = desktopBridge();

  // Keep the connected-clients count fresh while this panel is open.
  useEffect(() => {
    const timer = setInterval(() => void bridge?.control.status().then((i) => useControlInfo.getState().set(i)).catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [bridge]);

  const port = info?.port ?? settings.port;
  const base = `http://127.0.0.1:${port}`;
  const token = info?.token ?? "";
  const portValid = /^\d{4,5}$/.test(portDraft) && Number(portDraft) >= 1024 && Number(portDraft) <= 65535;

  return (
    <>
      <div className="di-stack">
        {info?.running ? (
          <StatusLine tone="ok">
            Listening on <Code>127.0.0.1:{info.port}</Code> (this computer only)
            {info.clients > 0 ? `, ${info.clients} live connection${info.clients === 1 ? "" : "s"}` : ""}
          </StatusLine>
        ) : (
          <StatusLine tone="warn">{info?.error ?? "Not running"}</StatusLine>
        )}
        <div>
          <label className="field-label" htmlFor="control-port">
            Port
          </label>
          <div className="di-row">
            <input
              id="control-port"
              className="text-input"
              inputMode="numeric"
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
            />
            <button
              className="btn primary di-btn"
              disabled={!portValid || Number(portDraft) === settings.port || busy}
              onClick={() => {
                setBusy(true);
                set({ port: Number(portDraft) });
                void bridge?.control
                  .start(Number(portDraft))
                  .then((i) => useControlInfo.getState().set(i))
                  .finally(() => setBusy(false));
              }}
            >
              Apply
            </button>
            <button className="btn ghost di-btn" disabled={portDraft === String(DEFAULT_PORT)} onClick={() => setPortDraft(String(DEFAULT_PORT))}>
              Default
            </button>
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor="control-token">
            Secret token
          </label>
          <div className="di-row">
            <input
              id="control-token"
              className="text-input"
              readOnly
              type={reveal ? "text" : "password"}
              value={token}
              aria-label="Secret token"
            />
            <button className="btn ghost di-btn" onClick={() => setReveal((r) => !r)}>
              {reveal ? "Hide" : "Show"}
            </button>
            <CopyButton text={token} />
            <button
              className="btn ghost di-btn"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void bridge?.control
                  .regenerateToken()
                  .then((i) => useControlInfo.getState().set(i))
                  .finally(() => setBusy(false));
              }}
            >
              New token
            </button>
          </div>
          <p className="di-note">
            Anything that knows this token can control playback on this computer. Keep it private. Making a new token stops
            everything that uses the old one.
          </p>
        </div>
      </div>

      <SettingRow
        title="Other plugins' commands"
        description="Let remotes also run commands that other plugins add. Off by default: only playback commands work."
      >
        <Toggle label="Allow other plugins' commands" on={settings.allowOthers} onChange={(v) => set({ allowOthers: v })} />
      </SettingRow>

      <div className="di-stack">
        <Help title="Stream Deck and scripts">
          <p>
            Every request needs the token, either as <Code>Authorization: Bearer TOKEN</Code> or as <Code>?token=TOKEN</Code> on
            the address. In Stream Deck, add an action from a plugin that sends HTTP requests (search the Stream Deck store for
            &quot;HTTP&quot; or &quot;API&quot;), choose method <Code>POST</Code> (or <Code>GET</Code>) and paste an address like these:
          </p>
          <CodeBlock>{`${base}/v1/command/play-pause?token=${reveal && token ? token : "TOKEN"}\n${base}/v1/command/next?token=${reveal && token ? token : "TOKEN"}\n${base}/v1/command/volume?value=0.4&token=${reveal && token ? token : "TOKEN"}`}</CodeBlock>
          <p>From a script or terminal:</p>
          <CodeBlock>{`curl -X POST -H "Authorization: Bearer TOKEN" ${base}/v1/command/next\ncurl -H "Authorization: Bearer TOKEN" ${base}/v1/state`}</CodeBlock>
          <p>
            <Code>GET /v1/state</Code> returns what is playing. <Code>GET /v1/commands</Code> lists command names. A WebSocket at{" "}
            <Code>ws://127.0.0.1:{port}/v1/ws?token=TOKEN</Code> sends the state whenever it changes and accepts messages like{" "}
            <Code>{`{"id":1,"command":"next"}`}</Code>.
          </p>
          <p>Commands:</p>
          <ul className="di-help-list">
            {COMMANDS.map(([name, what]) => (
              <li key={name}>
                <Code>/v1/command/{name}</Code> - {what}
              </li>
            ))}
          </ul>
          <p>
            Browsers cannot call this API from web pages on purpose (requests with an Origin header are refused), so a malicious
            site cannot press your buttons.
          </p>
        </Help>
      </div>

      <SettingRow
        title="MIDI controllers"
        description="Use a MIDI pad, keyboard or fader box as a remote. Pick a command, press Learn, then press a pad or move a knob."
      >
        <Toggle label="Use MIDI controllers" on={settings.midiEnabled} onChange={(v) => set({ midiEnabled: v })} />
      </SettingRow>
      {settings.midiEnabled && (
        <div className="di-stack">
          {midi.error ? (
            <StatusLine tone="warn">{midi.error}</StatusLine>
          ) : midi.inputs.length > 0 ? (
            <StatusLine tone="ok">
              {midi.inputs.join(", ")}
              {midi.lastSeen ? ` - last: ${midi.lastSeen}` : ""}
            </StatusLine>
          ) : (
            <StatusLine tone="off">No MIDI device found. Plug one in; it appears here.</StatusLine>
          )}
          <div className="di-row">
            <select
              className="text-input"
              aria-label="Command to map"
              value={learnTarget}
              onChange={(e) => setLearnTarget(e.target.value)}
            >
              {names().map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button
              className="btn primary di-btn"
              onClick={() => useMidiState.setState({ learning: midi.learning ? null : learnTarget })}
            >
              {midi.learning ? "Cancel" : "Learn"}
            </button>
          </div>
          {midi.learning && <p className="di-note">Waiting for you to press a pad or move a control for &quot;{midi.learning}&quot;...</p>}
          <div className="di-table">
            {settings.mappings.map((m) => (
              <div className="di-item" key={m.id}>
                <div className="di-item-main">
                  <div className="di-item-title">{m.command}</div>
                  <div className="di-item-sub">{describeMapping(m)}</div>
                </div>
                <button className="btn ghost di-btn" onClick={() => set({ mappings: settings.mappings.filter((x) => x.id !== m.id) })}>
                  Remove
                </button>
              </div>
            ))}
            {settings.mappings.length === 0 && <p className="di-note">Nothing mapped yet.</p>}
          </div>
        </div>
      )}
    </>
  );
}