import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { openDb } from "../../db.js";
import { createLocalUser } from "../../auth/users.js";
import { cleanRoomCode, HOST_IDLE_MS, HubFailure, MAX_MEMBERS, newRoomCode, RoomHub } from "./rooms.js";
import { createListenAlongPlugin } from "./plugin.js";

const track = (id: string) => ({ id, title: `Song ${id}`, artists: [{ id: "a", name: "Artist" }], durationSec: 200, source: "server" });

interface Ev {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

function collector() {
  const events: Ev[] = [];
  let closed = false;
  return {
    events,
    get closed() {
      return closed;
    },
    sink: {
      send: (event: string, data: unknown) => void events.push({ event, data }),
      close: () => {
        closed = true;
      },
    },
  };
}

test("room codes are short, unambiguous and cleaned from pasted text", () => {
  const code = newRoomCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(cleanRoomCode("  ab-c d12 "), "ABCD12");
  assert.equal(cleanRoomCode(42), "");
});

test("the host state is stamped by the server clock and relayed to guests", () => {
  let now = 1_000_000;
  const hub = new RoomHub(() => now);
  const room = hub.create({ id: 1, name: "Host" }, "Friday");
  const guest = collector();
  hub.subscribe(room.id, { id: 2, name: "Guest" }, guest.sink);
  assert.equal(guest.events[0].event, "hello");
  assert.equal(guest.events[0].data.state.track, null);

  now += 500;
  hub.setState(room.id, 1, { track: track("1"), playing: true, position: 12.5 });
  const last = guest.events[guest.events.length - 1];
  assert.equal(last.event, "state");
  assert.equal(last.data.state.updatedAt, now);
  assert.equal(last.data.state.position, 12.5);
  assert.equal(last.data.state.seq, 1);
  assert.equal(last.data.serverNow, now);
});

test("only the host can change or end a room", () => {
  const hub = new RoomHub();
  const room = hub.create({ id: 1, name: "Host" }, "");
  assert.throws(
    () => hub.setState(room.id, 2, { track: null, playing: false, position: 0 }),
    (e) => e instanceof HubFailure && e.code === "not_host",
  );
  assert.throws(
    () => hub.end(room.id, 2),
    (e) => e instanceof HubFailure && e.code === "not_host",
  );
  assert.throws(
    () => hub.setState("NOPE", 1, { track: null, playing: false, position: 0 }),
    (e) => e instanceof HubFailure && e.code === "not_found",
  );
  assert.equal(room.name, "Host\x27s room", "unnamed rooms get a friendly default");
});

test("listeners are counted once per person, and leaving updates everyone", () => {
  const hub = new RoomHub();
  const room = hub.create({ id: 1, name: "Host" }, "R");
  const host = collector();
  hub.subscribe(room.id, { id: 1, name: "Host" }, host.sink);
  const g1 = collector();
  const leave1 = hub.subscribe(room.id, { id: 2, name: "Bea" }, g1.sink);
  const g1b = collector(); // a second tab of the same person
  hub.subscribe(room.id, { id: 2, name: "Bea" }, g1b.sink);
  const g2 = collector();
  hub.subscribe(room.id, { id: 3, name: "Al" }, g2.sink);
  assert.deepEqual(hub.find(room.id)!.listeners, ["Al", "Bea"], "the host is not a listener");
  leave1();
  assert.deepEqual(hub.find(room.id)!.listeners, ["Al", "Bea"], "Bea is still here on her other tab");
  assert.deepEqual(host.events[host.events.length - 1].data.listeners, ["Al", "Bea"]);
});

test("ending a room tells everyone and closes their streams", () => {
  const hub = new RoomHub();
  const room = hub.create({ id: 1, name: "Host" }, "R");
  const g = collector();
  hub.subscribe(room.id, { id: 2, name: "G" }, g.sink);
  hub.end(room.id, 1);
  assert.equal(g.events[g.events.length - 1].event, "ended");
  assert.equal(g.closed, true);
  assert.equal(hub.find(room.id), null);
});

test("a host has one room, and a full room refuses more guests", () => {
  const hub = new RoomHub();
  const first = hub.create({ id: 1, name: "Host" }, "one");
  const g = collector();
  hub.subscribe(first.id, { id: 2, name: "G" }, g.sink);
  const second = hub.create({ id: 1, name: "Host" }, "two");
  assert.notEqual(first.id, second.id);
  assert.equal(hub.find(first.id), null, "the old room was closed");
  assert.equal(g.events[g.events.length - 1].event, "ended");
  assert.equal(hub.size, 1);
  for (let i = 0; i < MAX_MEMBERS; i++) hub.subscribe(second.id, { id: 100 + i, name: `g${i}` }, collector().sink);
  assert.throws(
    () => hub.subscribe(second.id, { id: 999, name: "late" }, collector().sink),
    (e) => e instanceof HubFailure && e.code === "room_full",
  );
});

test("rooms whose host went quiet are swept away, active ones are kept", () => {
  let now = 0;
  const hub = new RoomHub(() => now);
  const quiet = hub.create({ id: 1, name: "A" }, "quiet");
  const live = hub.create({ id: 2, name: "B" }, "live");
  hub.subscribe(live.id, { id: 2, name: "B" }, collector().sink);
  now += HOST_IDLE_MS + 1;
  assert.equal(hub.sweep(), 1);
  assert.equal(hub.find(quiet.id), null);
  assert.ok(hub.find(live.id));
});

// ---- Over HTTP, with a real server so the event stream can be read ----------

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-la-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "host", password: "host-password" });
  await createLocalUser(db, { username: "guest", password: "guest-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [createListenAlongPlugin()],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const signIn = async (username: string) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: `${username}-password` }),
    });
    return { authorization: `Bearer ${((await res.json()) as AuthResponse).token}` };
  };
  return {
    app,
    base,
    host: await signIn("host"),
    guest: await signIn("guest"),
    async close() {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Read server-sent events from a response until `stop` returns true. */
async function readEvents(res: Response, stop: (events: Ev[]) => boolean): Promise<Ev[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Ev[] = [];
  let buffer = "";
  while (!stop(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  await reader.cancel().catch(() => undefined);
  return events;
}
test("a guest follows the host over server-sent events, and anonymous users are refused", async () => {
  const s = await start();
  try {
    const json = { "content-type": "application/json" };
    assert.equal((await fetch(`${s.base}/api/listen-along/mine`)).status, 401);

    const created = await fetch(`${s.base}/api/listen-along/rooms`, { method: "POST", headers: { ...s.host, ...json }, body: JSON.stringify({ name: "Test" }) });
    assert.equal(created.status, 201);
    const { room } = (await created.json()) as { room: { id: string } };

    assert.equal((await fetch(`${s.base}/api/listen-along/rooms/${room.id}/events`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/listen-along/rooms/ZZZZZZ/events`, { headers: s.guest })).status, 404);

    const stream = await fetch(`${s.base}/api/listen-along/rooms/${room.id}/events`, { headers: s.guest });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const reading = readEvents(stream, (ev) => ev.some((e) => e.event === "state"));

    // A guest cannot steer the room.
    const denied = await fetch(`${s.base}/api/listen-along/rooms/${room.id}/state`, {
      method: "POST",
      headers: { ...s.guest, ...json },
      body: JSON.stringify({ track: track("x"), playing: true, position: 1 }),
    });
    assert.equal(denied.status, 403);

    // Give the stream a moment to attach before the host pushes.
    await new Promise((r) => setTimeout(r, 50));
    const pushed = await fetch(`${s.base}/api/listen-along/rooms/${room.id}/state`, {
      method: "POST",
      headers: { ...s.host, ...json },
      body: JSON.stringify({ track: track("server:1"), playing: true, position: 33 }),
    });
    assert.equal(pushed.status, 200);
    const events = await reading;
    assert.equal(events[0].event, "hello");
    assert.equal(events[0].data.room.hostName, "host");
    const state = events.find((e) => e.event === "state")!.data.state;
    assert.equal(state.track.id, "server:1");
    assert.equal(state.position, 33);
    assert.equal(state.playing, true);

    // Junk tracks are rejected; the room is unchanged.
    const junk = await fetch(`${s.base}/api/listen-along/rooms/${room.id}/state`, {
      method: "POST",
      headers: { ...s.host, ...json },
      body: JSON.stringify({ track: { nope: 1 }, playing: true, position: 1 }),
    });
    assert.equal(junk.status, 400);

    const looked = (await (await fetch(`${s.base}/api/listen-along/rooms/${room.id.toLowerCase()}`, { headers: s.guest })).json()) as Ev["data"];
    assert.equal(looked.state.track.id, "server:1");

    // Only the host can end it; ending tells a connected guest.
    assert.equal((await fetch(`${s.base}/api/listen-along/rooms/${room.id}`, { method: "DELETE", headers: s.guest })).status, 403);
    const second = await fetch(`${s.base}/api/listen-along/rooms/${room.id}/events`, { headers: s.guest });
    const waitEnd = readEvents(second, (ev) => ev.some((e) => e.event === "ended"));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await fetch(`${s.base}/api/listen-along/rooms/${room.id}`, { method: "DELETE", headers: s.host })).status, 204);
    assert.ok((await waitEnd).some((e) => e.event === "ended"));
    assert.equal((await fetch(`${s.base}/api/listen-along/rooms/${room.id}`, { headers: s.guest })).status, 404);
  } finally {
    await s.close();
  }
});

test("each person sees only the room they host", async () => {
  const s = await start();
  try {
    const json = { "content-type": "application/json" };
    await fetch(`${s.base}/api/listen-along/rooms`, { method: "POST", headers: { ...s.host, ...json }, body: "{}" });
    const mine = (await (await fetch(`${s.base}/api/listen-along/mine`, { headers: s.host })).json()) as { room: unknown };
    const theirs = (await (await fetch(`${s.base}/api/listen-along/mine`, { headers: s.guest })).json()) as { room: unknown };
    assert.ok(mine.room);
    assert.equal(theirs.room, null);
  } finally {
    await s.close();
  }
});