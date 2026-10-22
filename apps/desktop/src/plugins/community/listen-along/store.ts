import { create } from "zustand";
import { usePlayer } from "@/player/playerStore";
import { useTuning } from "@/player/tuning";
import { useServer } from "@/plugins/builtins/server/serverStore";
import type { PlaybackEvent, PlayerApi } from "@/plugins/types";
import type { Track } from "@/shared/types";
import { openEventStream, serverApi } from "../_social/serverApi";
import { clockOffset, correctDrift, expectedPosition, reconcile, type ClockSample, type HostSnapshot } from "./follow";

/** What the server sends about a room's playback. */
interface WireState {
  track: Track | null;
  playing: boolean;
  position: number;
  updatedAt: number;
  seq: number;
}
interface WireRoom {
  id: string;
  name: string;
  hostName: string;
}

export type Role = "none" | "host" | "guest";
export type Link = "idle" | "connecting" | "live" | "reconnecting" | "lost";

interface ListenState {
  role: Role;
  room: WireRoom | null;
  listeners: string[];
  link: Link;
  /** The host's track, as the guest sees it. */
  hostTrack: Track | null;
  host: HostSnapshot | null;
  /** Seconds this device is ahead (+) or behind (-) the host; null when not comparable. */
  drift: number | null;
  /** The host's track could not be played from this person's sources. */
  unplayable: Track | null;
  /** A short message for the person (room ended, connection lost...). */
  notice: string | null;
  error: string | null;
  busy: boolean;
  /** A room code from an invitation link, waiting to be joined. */
  invite: string | null;

  start: (name: string) => Promise<void>;
  end: () => Promise<void>;
  join: (code: string) => Promise<void>;
  leave: () => void;
  resync: () => void;
  resumeIfHosting: () => Promise<void>;
}

// ---- Wiring that is not UI state -------------------------------------------------------------
let player: PlayerApi | null = null;
let stopStream: (() => void) | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let offset = 0;
let lastOffsetAt = 0;
let lastSeekAt = 0;
let loadSeq = 0;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let currentRate = 1;
/** The player speed before drift correction touched it. */
let rateBefore: number | null = null;
let unplayableId: string | null = null;

const serverNow = () => Date.now() + offset;
const MAX_RETRIES = 6;

const trackSnapshot = (t: Track): Track => ({
  id: t.id,
  title: t.title,
  artists: t.artists,
  album: t.album,
  artwork: t.artwork,
  durationSec: t.durationSec,
  source: t.source,
});

function snapshotOf(state: WireState): HostSnapshot {
  return {
    trackId: state.track?.id ?? null,
    playing: state.playing,
    position: state.position,
    updatedAt: state.updatedAt,
    seq: state.seq,
    durationSec: state.track?.durationSec,
  };
}

async function measureOffset(): Promise<void> {
  const samples: ClockSample[] = [];
  for (let i = 0; i < 3; i++) {
    const sent = Date.now();
    try {
      const { now } = await serverApi<{ now: number }>("api/listen-along/time");
      samples.push({ sent, received: Date.now(), serverNow: now });
    } catch {
      // A missed sample just makes the estimate a little rougher.
    }
  }
  offset = clockOffset(samples);
  lastOffsetAt = Date.now();
}

function clearTimers() {
  if (tick) clearInterval(tick);
  if (heartbeat) clearInterval(heartbeat);
  if (pushTimer) clearTimeout(pushTimer);
  if (retryTimer) clearTimeout(retryTimer);
  tick = heartbeat = pushTimer = retryTimer = null;
}

function resetRate() {
  if (rateBefore !== null) {
    const tuning = useTuning.getState();
    // Give the speed back unless someone else (the speed plugin) has changed it since.
    if (tuning.rate === currentRate) tuning.set({ rate: rateBefore });
  }
  rateBefore = null;
  currentRate = 1;
}

/** The room has ended or been left: stop everything that belongs to it. */
function teardown() {
  loadSeq += 1;
  stopStream?.();
  stopStream = null;
  clearTimers();
  resetRate();
  unplayableId = null;
  retries = 0;
}

const quiet = {
  role: "none" as Role,
  room: null,
  listeners: [] as string[],
  link: "idle" as Link,
  hostTrack: null,
  host: null,
  drift: null,
  unplayable: null,
  busy: false,
};

export const useListenAlong = create<ListenState>((set, get) => {
  // ---- Guest: follow the host ---------------------------------------------------------------
  async function loadHostTrack(track: Track, mySeq: number) {
    if (!player) return;
    try {
      await player.playTracks([track], 0);
    } catch {
      // Handled by the unresolved check below.
    }
    if (mySeq !== loadSeq) return; // the host moved on while this was loading
    const now = usePlayer.getState();
    if (now.unresolved && now.current?.id === track.id) {
      unplayableId = track.id;
      set({ unplayable: track, drift: null });
      return;
    }
    unplayableId = null;
    set({ unplayable: null });
    const h = get().host;
    if (!h || h.trackId !== track.id) return;
    // Time has passed while loading: jump to where the host is now.
    const exp = expectedPosition(h, serverNow());
    if (exp > 1) {
      player.seek(exp);
      lastSeekAt = Date.now();
    }
    if (!h.playing && usePlayer.getState().isPlaying) player.toggle();
  }

  async function apply(full: boolean) {
    const { role, host, hostTrack } = get();
    if (role !== "guest" || !host || !player) return;
    const local = player.getState();
    const expected = expectedPosition(host, serverNow());

    if (full) {
      if (host.trackId && hostTrack && unplayableId === host.trackId && local.current?.id !== host.trackId) {
        return; // already known to be unplayable here; wait for the next track
      }
      const steps = reconcile(host, expected, { currentId: local.current?.id ?? null, isPlaying: local.isPlaying, position: local.position });
      for (const step of steps) {
        if (step.type === "load" && hostTrack) {
          const mySeq = ++loadSeq;
          set({ unplayable: null });
          await loadHostTrack(hostTrack, mySeq);
        } else if (step.type === "seek") {
          player.seek(step.to);
          lastSeekAt = Date.now();
        } else if (step.type === "play" || step.type === "pause") {
          player.toggle();
        }
      }
    } else if (host.trackId && local.current?.id === host.trackId && host.playing && local.isPlaying) {
      const drift = local.position - expected;
      set({ drift });
      const canAdjustRate = usePlayer.getState().engine === "html";
      const fix = correctDrift(drift, { canAdjustRate, sinceLastSeekMs: Date.now() - lastSeekAt });
      if (fix.kind === "seek") {
        player.seek(expected);
        lastSeekAt = Date.now();
      }
      if (canAdjustRate && fix.rate === 1 && currentRate !== 1) resetRate();
      else if (canAdjustRate && fix.rate !== currentRate) {
        // A small speed change (through the player's tuning settings) pulls the guest back in sync without a jump.
        if (rateBefore === null) rateBefore = useTuning.getState().rate;
        useTuning.getState().set({ rate: fix.rate });
        currentRate = fix.rate;
      }
      return;
    }
    if (!(host.trackId && local.current?.id === host.trackId)) set({ drift: null });
    else if (!host.playing || !local.isPlaying) set({ drift: null });
  }

  function onHostState(state: WireState) {
    const prev = get().host;
    if (prev && state.seq < prev.seq) return;
    set({ host: snapshotOf(state), hostTrack: state.track });
    void apply(true);
  }

  function connect(roomId: string, as: "host" | "guest") {
    stopStream?.();
    set({ link: retries > 0 ? "reconnecting" : "connecting" });
    stopStream = openEventStream(`api/listen-along/rooms/${roomId}/events`, {
      onEvent: (event, data) => {
        const d = data as Record<string, unknown>;
        if (event === "hello") {
          retries = 0;
          const room = d.room as WireRoom;
          set({ room, listeners: (d.listeners as string[]) ?? [], link: "live", notice: null });
          if (as === "guest") onHostState(d.state as WireState);
        } else if (event === "state" && as === "guest") {
          onHostState(d.state as WireState);
        } else if (event === "listeners") {
          set({ listeners: (d.listeners as string[]) ?? [] });
        } else if (event === "ended") {
          teardown();
          set({ ...quiet, notice: as === "guest" ? "The host ended the room." : "Your room was closed." });
        } else if (event === "error") {
          teardown();
          set({ ...quiet, error: d.error === "room_full" ? "That room is full." : "Couldn't join that room." });
        }
      },
      onEnd: (err) => {
        const { role } = get();
        if (role === "none") return;
        const status = (err as { status?: number } | undefined)?.status;
        if (status === 404 || status === 401) {
          teardown();
          set({ ...quiet, notice: status === 404 ? "The room is closed." : "You were signed out." });
          return;
        }
        if (retries >= MAX_RETRIES) {
          set({ link: "lost", notice: "Lost the connection to the room." });
          return;
        }
        retries += 1;
        set({ link: "reconnecting" });
        retryTimer = setTimeout(() => connect(roomId, as), Math.min(15_000, 1000 * 2 ** retries));
      },
    });
  }

  return {
    ...quiet,
    notice: null,
    error: null,
    invite: null,

    async start(name) {
      if (get().role !== "none") return;
      set({ busy: true, error: null, notice: null });
      try {
        const { room } = await serverApi<{ room: WireRoom }>("api/listen-along/rooms", { method: "POST", body: JSON.stringify({ name }) });
        set({ role: "host", room, listeners: [], busy: false });
        connect(room.id, "host");
        heartbeat = setInterval(() => void pushState(), 5000);
        void pushState();
      } catch (err) {
        set({ busy: false, error: (err as Error).message });
      }
    },

    async end() {
      const { room, role } = get();
      if (role !== "host" || !room) return;
      teardown();
      set({ ...quiet });
      try {
        await serverApi(`api/listen-along/rooms/${room.id}`, { method: "DELETE" });
      } catch {
        // The server closes idle rooms by itself.
      }
    },

    async resumeIfHosting() {
      if (get().role !== "none" || !useServer.getState().user) return;
      try {
        const { room } = await serverApi<{ room: WireRoom | null }>("api/listen-along/mine");
        if (!room || get().role !== "none") return;
        set({ role: "host", room, listeners: [] });
        connect(room.id, "host");
        heartbeat = setInterval(() => void pushState(), 5000);
        void pushState();
      } catch {
        // Older server or offline: nothing to resume.
      }
    },

    async join(code) {
      if (get().role !== "none") return;
      const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!clean) {
        set({ error: "Enter the room code." });
        return;
      }
      set({ busy: true, error: null, notice: null, invite: null });
      try {
        await measureOffset();
        const found = await serverApi<{ room: WireRoom; state: WireState }>(`api/listen-along/rooms/${clean}`);
        set({ role: "guest", room: found.room, busy: false, listeners: [] });
        connect(found.room.id, "guest");
        tick = setInterval(() => {
          if (Date.now() - lastOffsetAt > 90_000) void measureOffset();
          void apply(false);
        }, 1000);
      } catch (err) {
        const status = (err as { status?: number }).status;
        set({
          busy: false,
          error: status === 404 ? "No room with that code. Check it with the host." : status === 429 ? "Too many tries. Wait a moment." : (err as Error).message,
        });
      }
    },

    leave() {
      if (get().role !== "guest") return;
      teardown();
      set({ ...quiet, notice: "You left the room. Your music keeps playing." });
    },

    resync() {
      lastSeekAt = 0;
      unplayableId = null;
      void apply(true);
    },
  };
});

/** Wire the store to the player. Called each time the plugin activates. */
export function attachPlayer(api: PlayerApi): void {
  player = api;
}

/** Tell the server what this device is playing (host only). */
async function pushState() {
  const { room, role } = useListenAlong.getState();
  if (role !== "host" || !room || !player) return;
  const s = player.getState();
  try {
    await serverApi(`api/listen-along/rooms/${room.id}/state`, {
      method: "POST",
      body: JSON.stringify({ track: s.current ? trackSnapshot(s.current) : null, playing: s.isPlaying, position: s.position }),
    });
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      teardown();
      useListenAlong.setState({ ...quiet, notice: "Your room is no longer open." });
    }
  }
}

function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushState();
  }, 250);
}

/** Playback events from the host's own player. */
export function onHostPlayback(event: PlaybackEvent): void {
  if (useListenAlong.getState().role !== "host") return;
  if (event.kind === "progress") return; // the heartbeat covers steady playback
  schedulePush();
}

export function stopAll(): void {
  const { role, room } = useListenAlong.getState();
  teardown();
  if (role === "host" && room) void serverApi(`api/listen-along/rooms/${room.id}`, { method: "DELETE" }).catch(() => undefined);
  useListenAlong.setState({ ...quiet });
}

/** The address a guest opens to join (works in the web player, and shows the code for the desktop app). */
export function inviteLink(code: string): string {
  const base = useServer.getState().url || (typeof location !== "undefined" ? location.origin : "");
  return `${base.replace(/\/+$/, "")}/app/?room=${encodeURIComponent(code)}`;
}

/** Take a room code from `?room=CODE` in the address bar (the invitation link) and clear it. */
export function takeInviteFromLocation(): string | null {
  try {
    const params = new URLSearchParams(location.search);
    const code = params.get("room");
    if (!code) return null;
    params.delete("room");
    const qs = params.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
    return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
  } catch {
    return null;
  }
}