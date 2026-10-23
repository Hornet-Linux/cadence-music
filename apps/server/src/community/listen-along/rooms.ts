import { randomBytes } from "node:crypto";
import type { HistoryTrack } from "@uma/shared";

/** What the host is playing right now. `position` was true at `updatedAt` (server clock, epoch ms). */
export interface RoomState {
  track: HistoryTrack | null;
  playing: boolean;
  /** Seconds into the track at `updatedAt`. */
  position: number;
  updatedAt: number;
  /** Bumped on every host update, so a client can ignore a stale one. */
  seq: number;
}

export interface RoomInfo {
  id: string;
  name: string;
  hostName: string;
  createdAt: number;
}

/** Where a room's events go (an SSE response in production, an array in tests). */
export interface RoomSink {
  send: (event: string, data: unknown) => void;
  close: () => void;
}

interface Member {
  connId: number;
  userId: number;
  name: string;
  isHost: boolean;
  sink: RoomSink;
}

interface Room extends RoomInfo {
  hostId: number;
  state: RoomState;
  lastHostSeenAt: number;
  members: Map<number, Member>;
}

export const MAX_ROOMS = 200;
export const MAX_MEMBERS = 50;
/** A room whose host has been silent this long is closed. */
export const HOST_IDLE_MS = 10 * 60_000;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newRoomCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Normalise what a person typed or pasted into a room code. */
export function cleanRoomCode(input: unknown): string {
  return typeof input === "string" ? input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) : "";
}

export type HubError = "too_many_rooms" | "room_full" | "not_found" | "not_host";

export class HubFailure extends Error {
  constructor(readonly code: HubError) {
    super(code);
  }
}

/**
 * In-memory listening rooms. The host pushes its playback state; the hub stamps it with the
 * server clock and relays it to everyone who is subscribed. Rooms are not stored: they live only
 * as long as the host keeps them open.
 */
export class RoomHub {
  private readonly rooms = new Map<string, Room>();
  private nextConn = 1;

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.rooms.size;
  }

  create(host: { id: number; name: string }, name: string): RoomInfo {
    // One room per host: opening a new one closes the old one.
    for (const room of [...this.rooms.values()]) if (room.hostId === host.id) this.end(room.id, host.id);
    if (this.rooms.size >= MAX_ROOMS) throw new HubFailure("too_many_rooms");
    let id = newRoomCode();
    while (this.rooms.has(id)) id = newRoomCode();
    const now = this.now();
    const room: Room = {
      id,
      name: name.trim().slice(0, 60) || `${host.name}'s room`,
      hostName: host.name,
      createdAt: now,
      hostId: host.id,
      lastHostSeenAt: now,
      state: { track: null, playing: false, position: 0, updatedAt: now, seq: 0 },
      members: new Map(),
    };
    this.rooms.set(id, room);
    return this.info(room);
  }

  private info(room: Room): RoomInfo {
    return { id: room.id, name: room.name, hostName: room.hostName, createdAt: room.createdAt };
  }

  find(id: string): (RoomInfo & { state: RoomState; listeners: string[] }) | null {
    const room = this.rooms.get(id);
    return room ? { ...this.info(room), state: room.state, listeners: this.listenerNames(room) } : null;
  }

  /** The room a user is hosting, if any. */
  hostedBy(userId: number): RoomInfo | null {
    for (const room of this.rooms.values()) if (room.hostId === userId) return this.info(room);
    return null;
  }

  private listenerNames(room: Room): string[] {
    const names = new Map<number, string>();
    for (const m of room.members.values()) if (!m.isHost) names.set(m.userId, m.name);
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  private broadcast(room: Room, event: string, data: unknown): void {
    for (const member of room.members.values()) {
      try {
        member.sink.send(event, data);
      } catch {
        // A broken connection is cleaned up when it closes.
      }
    }
  }

  /** The host updates what is playing. */
  setState(
    id: string,
    hostId: number,
    update: { track: HistoryTrack | null; playing: boolean; position: number },
  ): RoomState {
    const room = this.rooms.get(id);
    if (!room) throw new HubFailure("not_found");
    if (room.hostId !== hostId) throw new HubFailure("not_host");
    const now = this.now();
    room.lastHostSeenAt = now;
    room.state = {
      track: update.track,
      playing: update.track ? update.playing : false,
      position: Math.max(0, update.position),
      updatedAt: now,
      seq: room.state.seq + 1,
    };
    this.broadcast(room, "state", { state: room.state, serverNow: now });
    return room.state;
  }

  /** Start receiving a room's events. Sends the current picture first. Returns a function that leaves. */
  subscribe(id: string, user: { id: number; name: string }, sink: RoomSink): () => void {
    const room = this.rooms.get(id);
    if (!room) throw new HubFailure("not_found");
    if (room.members.size >= MAX_MEMBERS) throw new HubFailure("room_full");
    const connId = this.nextConn++;
    const member: Member = { connId, userId: user.id, name: user.name, isHost: user.id === room.hostId, sink };
    room.members.set(connId, member);
    if (member.isHost) room.lastHostSeenAt = this.now();
    sink.send("hello", {
      room: this.info(room),
      state: room.state,
      listeners: this.listenerNames(room),
      serverNow: this.now(),
      isHost: member.isHost,
    });
    this.broadcast(room, "listeners", { listeners: this.listenerNames(room) });
    return () => {
      if (!room.members.delete(connId)) return;
      this.broadcast(room, "listeners", { listeners: this.listenerNames(room) });
    };
  }

  /** The host ends the room: everyone is told and disconnected. */
  end(id: string, hostId: number): void {
    const room = this.rooms.get(id);
    if (!room) throw new HubFailure("not_found");
    if (room.hostId !== hostId) throw new HubFailure("not_host");
    this.close(room);
  }

  private close(room: Room): void {
    this.rooms.delete(room.id);
    this.broadcast(room, "ended", { reason: "The host ended the room." });
    for (const member of room.members.values()) {
      try {
        member.sink.close();
      } catch {
        // Already gone.
      }
    }
    room.members.clear();
  }

  /** Keep connections alive, and close rooms whose host went away. */
  sweep(): number {
    const now = this.now();
    let closed = 0;
    for (const room of [...this.rooms.values()]) {
      const hostHere = [...room.members.values()].some((m) => m.isHost);
      if (!hostHere && now - room.lastHostSeenAt > HOST_IDLE_MS) {
        this.close(room);
        closed += 1;
      } else if (hostHere) {
        room.lastHostSeenAt = now;
      }
    }
    return closed;
  }

  ping(): void {
    for (const room of this.rooms.values()) this.broadcast(room, "ping", { serverNow: this.now() });
  }
}
