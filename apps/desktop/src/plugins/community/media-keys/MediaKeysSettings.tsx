import { useEffect, useState } from "react";
import { acceleratorFromKeyEvent, displayAccelerator } from "../../../../electron/accelerator";
import { SettingRow, Toggle } from "@/features/settings/controls";
import { usePluginHost } from "../../host";
import { desktopBridge, hostPlatform } from "../_desktop/desktop";
import { Help, StatusLine } from "../_desktop/panel";
import { effectiveBindings, shortcutWarning, withOverride } from "./bindings";
import { mediaKeysSettings, useShortcutState } from "./store";

/** Captures the next key combination. Escape cancels; Backspace or Delete alone clears. */
function KeyField({
  value,
  clash,
  onChange,
  label,
}: {
  value: string | null;
  clash: boolean;
  onChange: (accelerator: string | null) => void;
  label: string;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");
  const platform = hostPlatform();

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setRecording(false);
        setHint("");
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        setRecording(false);
        onChange(null);
        return;
      }
      const accelerator = acceleratorFromKeyEvent(e);
      if (!accelerator) return; // only modifiers so far
      setRecording(false);
      setHint("");
      onChange(accelerator);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  return (
    <button
      className={`di-key${recording ? " recording" : ""}${clash ? " clash" : ""}`}
      aria-label={`${label}: ${value ? displayAccelerator(value, platform) : "no shortcut"}. Press to change.`}
      onClick={() => {
        setHint("");
        setRecording((r) => !r);
      }}
      onBlur={() => setRecording(false)}
    >
      {recording ? "Press keys... (Esc to cancel)" : value ? displayAccelerator(value, platform) : "Not set"}
      {hint}
    </button>
  );
}

export function MediaKeysSettings() {
  const settings = mediaKeysSettings.useSettings((s) => s.values);
  const setSettings = mediaKeysSettings.useSettings((s) => s.set);
  const commands = usePluginHost((s) => s.contributions.commands);
  const { plan, results, systemControls, restartNeeded } = useShortcutState();
  const platform = hostPlatform();
  const bridge = desktopBridge();
  const bindings = effectiveBindings(commands, settings);
  const clashing = new Set((plan?.conflicts ?? []).flatMap((c) => c.ids));
  const set = (id: string, value: string | null | undefined) => setSettings(withOverride(settings, id, value));

  return (
    <>
      <SettingRow
        title="System media controls"
        description="Lets Windows, macOS and Linux show Cadence in their media overlay and respond to your keyboard's media keys, headset buttons and lock-screen controls. Takes effect after a restart."
      >
        <Toggle
          label="System media controls"
          on={!!systemControls}
          onChange={(on) => {
            void bridge?.system.setMediaControls(on).then((r) => {
              useShortcutState.setState({ systemControls: on, restartNeeded: r.restartRequired || restartNeeded });
            });
          }}
        />
      </SettingRow>
      {restartNeeded && (
        <div className="di-stack">
          <StatusLine tone="warn">Restart Cadence to apply this change.</StatusLine>
          <div className="di-row">
            <button className="btn primary di-btn" onClick={() => void bridge?.system.relaunch()}>
              Restart now
            </button>
          </div>
        </div>
      )}

      <div className="di-stack">
        <div>
          <div className="setting-title">Global shortcuts</div>
          <p className="setting-desc">
            These work even when Cadence is in the background. Click a shortcut, then press the keys you want. Escape cancels;
            Backspace removes it.
          </p>
        </div>
        <div className="di-table">
          {bindings.length === 0 && <p className="di-note">No commands are available yet.</p>}
          {bindings.map((b) => {
            const result = results[b.id];
            const problem = plan?.problems[b.id] ?? (result && !result.ok ? result.error : undefined);
            const warning = b.accelerator ? shortcutWarning(b.accelerator, platform) : null;
            return (
              <div className="di-item" key={b.id}>
                <div className="di-item-main">
                  <div className="di-item-title">{b.title}</div>
                  {problem ? (
                    <div className="di-item-sub di-bad">{problem}</div>
                  ) : b.accelerator && result?.ok ? (
                    <div className="di-item-sub">Active{warning ? `. ${warning}` : ""}</div>
                  ) : b.accelerator ? (
                    <div className="di-item-sub">Not active yet</div>
                  ) : b.suggestion ? (
                    <div className="di-item-sub">Suggested: {displayAccelerator(b.suggestion, platform)}</div>
                  ) : (
                    <div className="di-item-sub">No shortcut</div>
                  )}
                </div>
                <KeyField
                  label={b.title}
                  value={b.accelerator}
                  clash={clashing.has(b.id)}
                  onChange={(acc) => set(b.id, acc)}
                />
                {b.source === "user" && b.suggestion && b.suggestion !== b.accelerator && (
                  <button className="btn ghost di-btn" onClick={() => set(b.id, undefined)}>
                    Reset
                  </button>
                )}
                {b.source === "none" && b.suggestion && (
                  <button className="btn ghost di-btn" onClick={() => set(b.id, b.suggestion)}>
                    Use suggestion
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <Help title="Tips and limits">
          <p>
            Shortcuts need Ctrl, Alt or Cmd (or be a media key or F1 to F24) so they never steal ordinary typing. If two
            commands use the same keys, the first keeps them and the other is marked. If another program already owns a
            combination, Cadence cannot take it and says so here.
          </p>
          <p>
            Commands added by other plugins appear in this list too. Their suggested shortcuts are only offered, never
            switched on until you choose them.
          </p>
          <p>
            If you also turn on System media controls, avoid binding the dedicated media keys (Play/Pause key and so on)
            here: the system already sends those to Cadence, and both would fire.
          </p>
        </Help>
      </div>
    </>
  );
}