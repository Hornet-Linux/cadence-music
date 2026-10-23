import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { openDb } from "../../db.js";
import { createLocalUser } from "../../auth/users.js";
import plugin, { orderItems, type SharedPlaylistDetail } from "./plugin.js";

const track = (id: string, title = id) => ({
  id,
  title,
  artists: [{ id: "a", name: "Artist" }],
  artwork: "https://example.com/a.jpg",
  durationSec: 180,
  source: "server",
});

test("items are ordered by score, then by when they were added", () => {
  const ordered = orderItems([
    { id: "c", score: 1, addedAt: 3 },
    { id: "a", score: 1, addedAt: 1 },
    { id: "b", score: 5, addedAt: 2 },
    { id: "d", score: -2, addedAt: 0 },
  ]);
  assert.deepEqual(
    ordered.map((i) => i.id),
    ["b", "a", "c", "d"],
  );
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-sp-"));
  const db = openDb(":memory:");
  for (const name of ["alice", "bob", "carol"]) await createLocalUser(db, { username: name, password: `${name}-password` });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, musicDir: dir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [plugin],
  });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  const call = async (who: Record<string, string>, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: who, payload: payload as object | undefined });
  return {
    app,
    call,
    alice: await signIn("alice"),
    bob: await signIn("bob"),
    carol: await signIn("carol"),
    async close() {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("members build a playlist together, vote it into order and strangers see nothing", async () => {
  const s = await setup();
  try {
    assert.equal((await s.app.inject({ method: "GET", url: "/api/shared-playlists" })).statusCode, 401);

    const made = await s.call(s.alice, "POST", "/api/shared-playlists", { name: "Road trip", tracks: [track("t1", "One"), { bad: true }] });
    assert.equal(made.statusCode, 201);
    const created = made.json() as SharedPlaylistDetail;
    assert.equal(created.items.length, 1);
    assert.equal(created.isOwner, true);
    assert.match(created.joinCode ?? "", /^[A-Z0-9]{8}$/);

    // A stranger cannot see it, add to it, or learn that it exists.
    for (const [method, url] of [
      ["GET", `/api/shared-playlists/${created.id}`],
      ["POST", `/api/shared-playlists/${created.id}/items`],
      ["DELETE", `/api/shared-playlists/${created.id}`],
    ] as const) {
      const res = await s.call(s.bob, method, url, method === "POST" ? { track: track("x") } : undefined);
      assert.equal(res.statusCode, 404, `${method} ${url}`);
    }
    assert.equal(((await s.call(s.bob, "GET", "/api/shared-playlists")).json() as { items: unknown[] }).items.length, 0);

    // Bob joins with the code; wrong codes are refused.
    assert.equal((await s.call(s.bob, "POST", "/api/shared-playlists/join", { code: "WRONGCODE" })).statusCode, 404);
    const joined = await s.call(s.bob, "POST", "/api/shared-playlists/join", { code: created.joinCode!.toLowerCase() });
    assert.equal(joined.statusCode, 200);
    const asBob = joined.json() as SharedPlaylistDetail;
    assert.equal(asBob.isOwner, false);
    assert.equal(asBob.joinCode, undefined, "only the owner sees the invite code");
    assert.deepEqual(asBob.members.map((m) => m.name), ["alice", "bob"]);

    // Bob adds two tracks; duplicates are refused.
    assert.equal((await s.call(s.bob, "POST", `/api/shared-playlists/${created.id}/items`, { track: track("t2", "Two") })).statusCode, 201);
    assert.equal((await s.call(s.bob, "POST", `/api/shared-playlists/${created.id}/items`, { track: track("t3", "Three") })).statusCode, 201);
    assert.equal((await s.call(s.bob, "POST", `/api/shared-playlists/${created.id}/items`, { track: track("t2", "Two") })).statusCode, 409);
    assert.equal((await s.call(s.bob, "POST", `/api/shared-playlists/${created.id}/items`, { track: { nope: 1 } })).statusCode, 400);

    let detail = (await s.call(s.alice, "GET", `/api/shared-playlists/${created.id}`)).json() as SharedPlaylistDetail;
    assert.deepEqual(detail.items.map((i) => i.track.id), ["t1", "t2", "t3"], "equal scores keep the order added");
    assert.equal(detail.items[1].addedBy?.name, "bob");

    // Alice votes t3 up, bob votes t1 down: t3 (2) > t2 (1) > t1 (0).
    const t3 = detail.items[2].id;
    const t1 = detail.items[0].id;
    assert.equal((await s.call(s.alice, "PUT", `/api/shared-playlists/${created.id}/items/${t3}/vote`, { value: 1 })).statusCode, 200);
    const afterVote = await s.call(s.bob, "PUT", `/api/shared-playlists/${created.id}/items/${t1}/vote`, { value: -1 });
    detail = afterVote.json() as SharedPlaylistDetail;
    assert.deepEqual(detail.items.map((i) => i.track.id), ["t3", "t2", "t1"]);
    assert.deepEqual(detail.items.map((i) => i.score), [2, 1, 0]);
    assert.equal(detail.items[2].myVote, -1, "each person sees their own vote");
    assert.equal((await s.call(s.bob, "PUT", `/api/shared-playlists/${created.id}/items/${t1}/vote`, { value: 5 })).statusCode, 400);

    // Taking a vote back works.
    detail = (await s.call(s.bob, "PUT", `/api/shared-playlists/${created.id}/items/${t1}/vote`, { value: 0 })).json() as SharedPlaylistDetail;
    assert.equal(detail.items.find((i) => i.id === t1)!.score, 1);

    // Polling with the current timestamp returns nothing new.
    const same = (await s.call(s.alice, "GET", `/api/shared-playlists/${created.id}?since=${detail.updatedAt}`)).json() as { unchanged?: boolean };
    assert.equal(same.unchanged, true);

    // Removing: bob can remove his own track but not alice's; alice (owner) can remove any.
    assert.equal((await s.call(s.bob, "DELETE", `/api/shared-playlists/${created.id}/items/${t1}`)).statusCode, 403);
    const t2 = detail.items.find((i) => i.track.id === "t2")!.id;
    assert.equal((await s.call(s.bob, "DELETE", `/api/shared-playlists/${created.id}/items/${t2}`)).statusCode, 204);
    assert.equal((await s.call(s.alice, "DELETE", `/api/shared-playlists/${created.id}/items/${t3}`)).statusCode, 204);
    detail = (await s.call(s.alice, "GET", `/api/shared-playlists/${created.id}`)).json() as SharedPlaylistDetail;
    assert.deepEqual(detail.items.map((i) => i.track.id), ["t1"]);

    // Only the owner can rename, invite, or delete.
    assert.equal((await s.call(s.bob, "PATCH", `/api/shared-playlists/${created.id}`, { name: "Mine now" })).statusCode, 403);
    assert.equal((await s.call(s.bob, "POST", `/api/shared-playlists/${created.id}/members`, { username: "carol" })).statusCode, 403);
    assert.equal((await s.call(s.alice, "POST", `/api/shared-playlists/${created.id}/members`, { username: "nobody" })).statusCode, 404);
    const invited = (await s.call(s.alice, "POST", `/api/shared-playlists/${created.id}/members`, { username: "carol" })).json() as SharedPlaylistDetail;
    assert.equal(invited.members.length, 3);
    assert.equal((await s.call(s.alice, "PATCH", `/api/shared-playlists/${created.id}`, { name: "Road trip 2" })).statusCode, 200);

    // Bob leaves; he loses access, and his votes go with him.
    assert.equal((await s.call(s.bob, "DELETE", `/api/shared-playlists/${created.id}/members/me`)).statusCode, 204);
    assert.equal((await s.call(s.bob, "GET", `/api/shared-playlists/${created.id}`)).statusCode, 404);
    const cantLeave = await s.call(s.alice, "DELETE", `/api/shared-playlists/${created.id}/members/${created.ownerId}`);
    assert.equal(cantLeave.statusCode, 409, "the owner deletes the playlist instead of leaving");

    // Old code can be replaced; the old one stops working.
    const oldCode = created.joinCode!;
    const fresh = (await s.call(s.alice, "POST", `/api/shared-playlists/${created.id}/code`)).json() as { joinCode: string };
    assert.notEqual(fresh.joinCode, oldCode);
    assert.equal((await s.call(s.bob, "POST", "/api/shared-playlists/join", { code: oldCode })).statusCode, 404);

    assert.equal((await s.call(s.carol, "DELETE", `/api/shared-playlists/${created.id}`)).statusCode, 403);
    assert.equal((await s.call(s.alice, "DELETE", `/api/shared-playlists/${created.id}`)).statusCode, 204);
    assert.equal((await s.call(s.carol, "GET", `/api/shared-playlists/${created.id}`)).statusCode, 404);
  } finally {
    await s.close();
  }
});

test("a person lists only playlists they belong to, with covers and counts", async () => {
  const s = await setup();
  try {
    await s.call(s.alice, "POST", "/api/shared-playlists", { name: "A", tracks: [track("a1"), track("a2")] });
    await s.call(s.bob, "POST", "/api/shared-playlists", { name: "B" });
    const mine = (await s.call(s.alice, "GET", "/api/shared-playlists")).json() as { items: { name: string; trackCount: number; memberCount: number; artwork: string[]; isOwner: boolean }[] };
    assert.deepEqual(mine.items.map((p) => p.name), ["A"]);
    assert.equal(mine.items[0].trackCount, 2);
    assert.equal(mine.items[0].memberCount, 1);
    assert.equal(mine.items[0].isOwner, true);
    assert.equal(mine.items[0].artwork.length, 2);
    assert.equal((await s.call(s.alice, "POST", "/api/shared-playlists", { name: "  " })).statusCode, 400);
  } finally {
    await s.close();
  }
});
