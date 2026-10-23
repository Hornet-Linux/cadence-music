import { useEffect, useState } from "react";
import { create } from "zustand";
import { Toggle } from "@/features/settings/controls";
import { useCollection } from "@/features/collection/collectionStore";
import type { Plugin, PluginContext } from "@/plugins/types";
import type { Track } from "@/shared/types";
import { createPrefs } from "../_audio-kit/prefs";
import { Note, Row, Section, Slider } from "../_audio-kit/ui";
import {
  DAY_NAMES,
  MAX_ALARMS,
  describeDays,
  describeNext,
  newAlarm,
  nextOccurrence,
  parseTime,
  sanitizeAlarm,
  type Alarm,
  type AlarmSource,
} from "./alarm";
import { AlarmScheduler, ringAlarm, type RingResult } from "./scheduler";
import "./style.css";

interface AlarmPrefs {
  alarms: Alarm[];
  keepAwake: boolean;
}

export const alarmPrefs = createPrefs<AlarmPrefs>("settings", { alarms: [], keepAwake: false }, (v) => ({
  alarms: (Array.isArray(v.alarms) ? v.alarms : [])
    .map((a, i) => sanitizeAlarm(a, `alarm-${i}`))
    .filter((a): a is Alarm => a !== null)
    .slice(0, MAX_ALARMS),
  keepAwake: v.keepAwake === true,
}));

/** What happened most recently, shown at the top of the panel. */
export const useAlarmStatus = create<{ message: string | null }>(() => ({ message: null }));

let player: PluginContext["player"] | null = null;

const label = (a: Alarm) => a.label.trim() || a.time;

export function tracksFor(alarm: Alarm): Track[] {
  const { likes, playlists } = useCollection.getState();
  switch (alarm.source.kind) {
    case "liked":
      return [...likes].sort((a, b) => b.likedAt - a.likedAt).map((l) => l.track);
    case "playlist": {
      const id = alarm.source.id;
      return playlists.find((p) => p.id === id)?.tracks ?? [];
    }
    case "queue":
      return player ? player.getState().queue : [];
  }
}

const REASONS: Record<Extract<RingResult, { ok: false }>["reason"], string> = {
  empty: "there was nothing to play. Check the playlist or liked songs.",
  blocked: "the browser did not allow playback to start. Open Cadence and press play once, then keep it open.",
  error: "playback could not start. Is your server reachable?",
};

export async function handleRing(alarm: Alarm) {
  if (!player) return;
  useAlarmStatus.setState({ message: `Ringing: ${label(alarm)}` });
  const result = await ringAlarm(alarm, { player, tracksFor });
  useAlarmStatus.setState({
    message: result.ok ? `Alarm "${label(alarm)}" is playing.` : `Alarm "${label(alarm)}" could not start: ${REASONS[result.reason]}`,
  });
}

export const scheduler = new AlarmScheduler({
  now: () => new Date(),
  alarms: () => alarmPrefs.get().alarms,
  update: (id, patch) => alarmPrefs.set({ alarms: alarmPrefs.get().alarms.map((a) => (a.id === id ? { ...a, ...patch } : a)) }),
  ring: (alarm) => void handleRing(alarm),
  missed: (alarm, at) =>
    useAlarmStatus.setState({
      message: `Missed alarm "${label(alarm)}" at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: Cadence was not running or the device was asleep.`,
    }),
});

// ---- keep-awake (screen wake lock) ------------------------------------------

let lock: WakeLockSentinel | null = null;

export async function syncWakeLock() {
  const { alarms, keepAwake } = alarmPrefs.get();
  const want = keepAwake && alarms.some((a) => a.enabled);
  try {
    if (want && !lock && typeof navigator !== "undefined" && navigator.wakeLock && document.visibilityState === "visible") {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => {
        lock = null;
      });
    } else if (!want && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    // Refused (battery saver etc.): the alarm still works while the screen is on.
  }
}

alarmPrefs.use.subscribe(() => void syncWakeLock());
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => void syncWakeLock());

// ---- panel ---------------------------------------------------------------------

function sourceValue(s: AlarmSource) {
  return s.kind === "playlist" ? `playlist:${s.id}` : s.kind;
}
function parseSource(v: string): AlarmSource {
  if (v.startsWith("playlist:")) return { kind: "playlist", id: v.slice("playlist:".length) };
  return v === "queue" ? { kind: "queue" } : { kind: "liked" };
}

function AlarmCard({ alarm }: { alarm: Alarm }) {
  const playlists = useCollection((s) => s.playlists);
  const patch = (p: Partial<Alarm>) =>
    // Editing re-arms the alarm so an earlier time today does not ring straight away.
    alarmPrefs.set({ alarms: alarmPrefs.get().alarms.map((a) => (a.id === alarm.id ? { ...a, ...p, armedAt: Date.now() } : a)) });
  const toggleDay = (d: number) =>
    patch({ days: alarm.days.includes(d) ? alarm.days.filter((x) => x !== d) : [...alarm.days, d].sort() });
  const next = nextOccurrence(alarm, new Date());
  const missingPlaylist = alarm.source.kind === "playlist" && !playlists.some((p) => p.id === (alarm.source as { id: string }).id);

  return (
    <li className={`alarm-card${alarm.enabled ? "" : " off"}`}>
      <div className="alarm-top">
        <input
          className="ax-input alarm-time"
          type="time"
          value={alarm.time}
          aria-label="Alarm time"
          onChange={(e) => parseTime(e.target.value) && patch({ time: e.target.value })}
        />
        <Toggle on={alarm.enabled} onChange={(enabled) => patch({ enabled })} label={`Alarm ${label(alarm)} on`} />
      </div>
      <p className="ax-hint" aria-live="polite">
        {describeDays(alarm.days)}. {alarm.enabled ? describeNext(next, new Date()) : "Off"}
      </p>
      <input
        className="ax-input"
        placeholder="Name (optional)"
        maxLength={40}
        value={alarm.label}
        aria-label="Alarm name"
        onChange={(e) => alarmPrefs.set({ alarms: alarmPrefs.get().alarms.map((a) => (a.id === alarm.id ? { ...a, label: e.target.value } : a)) })}
      />
      <div className="alarm-days" role="group" aria-label="Repeat on">
        {DAY_NAMES.map((name, d) => (
          <button
            key={name}
            type="button"
            className={`ax-chip${alarm.days.includes(d) ? " on" : ""}`}
            aria-pressed={alarm.days.includes(d)}
            onClick={() => toggleDay(d)}
          >
            {name.slice(0, 2)}
          </button>
        ))}
      </div>
      <label className="alarm-field">
        <span className="ax-hint">Play</span>
        <select className="ax-input" value={sourceValue(alarm.source)} onChange={(e) => patch({ source: parseSource(e.target.value) })} aria-label="What to play">
          <option value="liked">Liked songs</option>
          <option value="queue">The current queue</option>
          {playlists.map((p) => (
            <option key={p.id} value={`playlist:${p.id}`}>
              Playlist: {p.name}
            </option>
          ))}
        </select>
      </label>
      {missingPlaylist && <p className="ax-hint">That playlist no longer exists.</p>}
      <Row title="Shuffle">
        <Toggle on={alarm.shuffle} onChange={(shuffle) => patch({ shuffle })} label="Shuffle" />
      </Row>
      <Slider
        label="Wake up gently over"
        value={alarm.rampSec}
        min={0}
        max={120}
        step={5}
        format={(v) => (v === 0 ? "Full volume at once" : `${v} s`)}
        onChange={(rampSec) => patch({ rampSec })}
      />
      <button
        type="button"
        className="ax-btn quiet"
        onClick={() => alarmPrefs.set({ alarms: alarmPrefs.get().alarms.filter((a) => a.id !== alarm.id) })}
      >
        Delete alarm
      </button>
    </li>
  );
}

export function AlarmPanel() {
  const { alarms, keepAwake } = alarmPrefs.use();
  const message = useAlarmStatus((s) => s.message);
  // Re-render each minute so "Rings in..." stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const add = () =>
    alarmPrefs.set({ alarms: [...alarms, newAlarm(Date.now(), `alarm-${Date.now().toString(36)}`)] });

  return (
    <div className="ax">
      <Note tone="warn">
        Alarms ring only while Cadence is open and the device is awake. Phones and tablets often suspend web pages when the
        screen turns off or the app is in the background, so a closed or sleeping page will not ring. Keep Cadence open (and the
        device charging), and use your device&apos;s own alarm as a backup for anything important.
      </Note>

      {message && (
        <p className="ax-status" role="status" aria-live="polite">
          {message}
        </p>
      )}

      <Section title="Alarms">
        {alarms.length === 0 && <p className="ax-hint">No alarms yet.</p>}
        <ul className="alarm-list">
          {alarms.map((a) => (
            <AlarmCard key={a.id} alarm={a} />
          ))}
        </ul>
        <button type="button" className="ax-btn" onClick={add} disabled={alarms.length >= MAX_ALARMS}>
          {alarms.length >= MAX_ALARMS ? `Up to ${MAX_ALARMS} alarms` : "Add alarm"}
        </button>
      </Section>

      <Section title="Phone helpers">
        <Row title="Keep the screen on" description="While an alarm is set and Cadence is visible, ask the device not to dim and lock. Uses more battery.">
          <Toggle on={keepAwake} onChange={(v) => alarmPrefs.set({ keepAwake: v })} label="Keep the screen on while an alarm is set" />
        </Row>
      </Section>
    </div>
  );
}

const alarmPlugin: Plugin = {
  manifest: {
    id: "cadence.alarm",
    name: "Alarm Clock",
    version: "1.0.0",
    description: "Wake up to a playlist or your liked songs at a time you choose. Works while Cadence is open.",
    author: "Cadence",
    capabilities: ["ui.settings", "storage", "player.read", "player.queue", "commands"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    alarmPrefs.bind(ctx.storage);
    player = ctx.player;
    ctx.registerSettingsPanel({
      id: "alarm",
      title: "Alarm Clock",
      description: "Wake up to music. Needs Cadence to stay open.",
      keywords: ["alarm", "wake", "morning", "clock", "timer"],
      render: () => <AlarmPanel />,
    });
    ctx.registerCommand({
      id: "alarm-dismiss",
      title: "Turn off all alarms",
      keywords: ["alarm", "off", "cancel"],
      run: () => alarmPrefs.set({ alarms: alarmPrefs.get().alarms.map((a) => ({ ...a, enabled: false })) }),
    });
    scheduler.start();
    void syncWakeLock();
  },
  deactivate() {
    scheduler.stop();
    void syncWakeLock();
  },
};

export default alarmPlugin;
