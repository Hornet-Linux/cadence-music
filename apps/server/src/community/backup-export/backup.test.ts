import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { crc32 } from "node:zlib";
import { collectionPlugin } from "../../collection/plugin.js";
import { openDb } from "../../db.js";
import { historyPlugin } from "../../history/plugin.js";
import { makeApp } from "../_ops/testkit.js";
import { csvCell, fileStem, historyToCsv, makeZip, toM3U, toXSPF, xmlEscape } from "./formats.js";
import backupExport, { clampConfig } from "./plugin.js";
import { checkSnapshot, createSnapshot, isSnapshotName, listSnapshots, pruneSnapshots, snapshotName } from "./snapshot.js";

const tracks = [
  { id: "server:abc", title: "Fish & Chips <live>", artists: [{ name: "The Smiths" }, { name: "Morrissey" }], album: "Louder Than Bombs", durationSec: 201.4 },
  { id: "spotify:track:xyz", title: "Line\nBreak", artists: [], durationSec: undefined },
];
const locate = (t: { id: string }) => (t.id === "server:abc" ? "Smiths/Louder Than Bombs/01 Fish & Chips.flac" : t.id);

test("M3U carries durations, artists and a location per track on single lines", () => {
  const m3u = toM3U("Road trip\nmix", tracks, locate);
  const lines = m3u.trimEnd().split("\n");
  assert.equal(lines[0], "#EXTM3U");
  assert.equal(lines[1], "#PLAYLIST:Road trip mix");
  assert.ok(lines.includes("#EXTINF:201,The Smiths, Morrissey - Fish & Chips <live>"));
  assert.ok(lines.includes("Smiths/Louder Than Bombs/01 Fish & Chips.flac"));
  assert.ok(lines.includes("#EXTINF:-1,Line Break"));
  assert.ok(lines.includes("spotify:track:xyz"));
});

test("XSPF escapes markup, encodes paths and keeps URIs", () => {
  const xml = toXSPF("A <b> & \u0001C", tracks, locate);
  assert.match(xml, /<title>A &lt;b&gt; &amp; C<\/title>/);
  assert.match(xml, /<location>Smiths\/Louder%20Than%20Bombs\/01%20Fish%20&amp;%20Chips\.flac<\/location>/);
  assert.match(xml, /<location>spotify:track:xyz<\/location>/);
  assert.match(xml, /<duration>201400<\/duration>/);
  assert.equal(xmlEscape(`"'`), "&quot;&apos;");
  assert.ok(!xml.includes("\u0001"));
});

test("CSV quotes cells, and neutralises spreadsheet formulas", () => {
  assert.equal(csvCell('He said "hi", then left'), '"He said ""hi"", then left"');
  assert.equal(csvCell("=HYPERLINK(\"x\")"), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell("+44 20"), "'+44 20");
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvCell(null), "");
  const csv = historyToCsv([{ playedAt: Date.UTC(2026, 0, 2, 3, 4, 5), track: { id: "t", title: "Song, one", artists: [{ name: "A" }, { name: "B" }], durationSec: 12 } }]);
  assert.equal(csv.split("\r\n")[0], "played_at,title,artists,album,duration_sec,source,track_id");
  assert.equal(csv.split("\r\n")[1], '2026-01-02T03:04:05.000Z,"Song, one","A, B",,12,,t');
});

test("file names are made safe", () => {
  assert.equal(fileStem("Café: Best/Of?"), "Cafe_ Best_Of_");
  assert.equal(fileStem("..."), "playlist");
  assert.equal(fileStem(""), "playlist");
});

/** Read a stored ZIP back and check the CRCs, the way an unzip tool would. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50);
    const crc = buf.readUInt32LE(pos + 16);
    const size = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26);
    const data = buf.subarray(start, start + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out.set(name, Buffer.from(data));
    pos += 46 + nameLen;
  }
  return out;
}

test("the ZIP writer produces archives whose entries and checksums read back", () => {
  const zip = makeZip([
    { name: "Road trip.m3u8", data: Buffer.from("#EXTM3U\n") },
    { name: "Zażółć.xspf", data: Buffer.from("<playlist/>") },
  ]);
  const entries = readZip(zip);
  assert.deepEqual([...entries.keys()], ["Road trip.m3u8", "Zażółć.xspf"]);
  assert.equal(entries.get("Road trip.m3u8")!.toString(), "#EXTM3U\n");
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cadence-snap-"));
}

test("a snapshot is a consistent, openable copy that a fresh server can start from", () => {
  const dir = tempDir();
  try {
    const live = openDb(path.join(dir, "music.db"));
    live.exec("INSERT INTO users (username, created_at) VALUES ('ana', 1), ('ben', 2)");
    live.exec("INSERT INTO tracks (id, rel_path, title, size, mtime_ms, added_at) VALUES ('t1', 'a.flac', 'A', 1, 1, 1)");
    const made = createSnapshot(live, path.join(dir, "backups"), "manual", new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
    assert.equal(made.name, "cadence-manual-20260102-030405.sqlite");
    assert.equal(made.check.ok, true);
    assert.equal(made.check.users, 2);
    // The live database keeps changing; the snapshot does not.
    live.exec("INSERT INTO users (username, created_at) VALUES ('cy', 3)");
    const file = path.join(dir, "backups", made.name);
    const check = checkSnapshot(file);
    assert.equal(check.integrity, "ok");
    assert.equal(check.users, 2);
    assert.equal(check.tracks, 1);
    assert.equal(check.schemaVersion, (live.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    assert.deepEqual(fs.readdirSync(path.join(dir, "backups")), [made.name], "no partial file is left behind");
    // The header proves it is a real SQLite file.
    assert.equal(fs.readFileSync(file).subarray(0, 15).toString(), "SQLite format 3");
    // Restore = copy it to music.db: openDb accepts it and the data is there.
    const restored = path.join(dir, "restored.db");
    fs.copyFileSync(file, restored);
    const db2 = openDb(restored);
    assert.equal((db2.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 2);
    db2.close();
    live.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged snapshot is detected", () => {
  const dir = tempDir();
  try {
    const bad = path.join(dir, "bad.sqlite");
    const db = new DatabaseSync(bad);
    db.exec("CREATE TABLE users (id INTEGER); INSERT INTO users VALUES (1)");
    db.close();
    const bytes = fs.readFileSync(bad);
    fs.writeFileSync(bad, bytes.subarray(0, 100)); // chopped off
    assert.throws(() => checkSnapshot(bad));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("names are unique per second, validated, and retention only prunes scheduled snapshots", () => {
  const dir = tempDir();
  try {
    const db = openDb(":memory:");
    const when = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));
    const a = createSnapshot(db, dir, "auto", when);
    const b = createSnapshot(db, dir, "auto", when);
    assert.notEqual(a.name, b.name);
    assert.match(b.name, /-2\.sqlite$/);
    assert.equal(snapshotName("auto", when, () => false), "cadence-auto-20260601-120000.sqlite");
    for (const n of [a.name, b.name]) assert.equal(isSnapshotName(n), true);
    for (const n of ["../x.sqlite", "cadence-auto-1.sqlite", "music.db", "cadence-manual-20260102-030405.sqlite.partial"]) assert.equal(isSnapshotName(n), false);

    // Five scheduled snapshots (oldest first by mtime) and one manual one.
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = createSnapshot(db, dir, "auto", new Date(Date.UTC(2026, 6, 1 + i)));
      fs.utimesSync(path.join(dir, s.name), new Date(2026, 6, 1 + i), new Date(2026, 6, 1 + i));
      names.push(s.name);
    }
    const manual = createSnapshot(db, dir, "manual", new Date(Date.UTC(2020, 0, 1)));
    fs.utimesSync(path.join(dir, manual.name), new Date(2020, 0, 1), new Date(2020, 0, 1));
    fs.utimesSync(path.join(dir, a.name), new Date(2026, 5, 1), new Date(2026, 5, 1));
    fs.utimesSync(path.join(dir, b.name), new Date(2026, 5, 1), new Date(2026, 5, 1));
    const removed = pruneSnapshots(dir, 3);
    assert.equal(removed.length, 4);
    const left = listSnapshots(dir).map((s) => s.name);
    assert.deepEqual(left.filter((n) => n.includes("-auto-")), [names[4], names[3], names[2]]);
    assert.ok(left.includes(manual.name), "manual snapshots stay");
    assert.equal(pruneSnapshots(dir, 0).length, 2, "at least one scheduled snapshot is always kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("settings are clamped to sensible values", () => {
  assert.deepEqual(clampConfig({ enabled: true, everyHours: 0, keep: 1000 }), { enabled: true, everyHours: 1, keep: 60 });
  assert.deepEqual(clampConfig({ everyHours: 99999 }).everyHours, 720);
  assert.deepEqual(clampConfig({ keep: Number.NaN, everyHours: Number.NaN }), { enabled: false, everyHours: 24, keep: 7 });
});

test("export and backup routes: ownership, formats and admin-only snapshots", async () => {
  const t = await makeApp([historyPlugin, collectionPlugin, backupExport]);
  try {
    const user = t.auth(t.userToken);
    const admin = t.auth(t.adminToken);
    const mine = await t.app.inject({
      method: "POST",
      url: "/api/me/playlists",
      headers: user,
      payload: { name: "Evening: chill", tracks: [{ id: "spotify:track:1", title: "Song One", artists: [{ id: "a", name: "Artist" }], durationSec: 100 }] },
    });
    const playlistId = (mine.json() as { id: string }).id;
    const others = await t.app.inject({ method: "POST", url: "/api/me/playlists", headers: admin, payload: { name: "Admin secret" } });
    const adminListId = (others.json() as { id: string }).id;

    const m3u = await t.app.inject({ method: "GET", url: `/api/export/playlists/${playlistId}?format=m3u`, headers: user });
    assert.equal(m3u.statusCode, 200);
    assert.match(m3u.headers["content-disposition"] as string, /attachment; filename="Evening_ chill\.m3u8"/);
    assert.match(m3u.body, /#EXTINF:100,Artist - Song One\nspotify:track:1/);
    const xspf = await t.app.inject({ method: "GET", url: `/api/export/playlists/${playlistId}?format=xspf`, headers: user });
    assert.match(xspf.body, /<playlist version="1"/);
    // Someone else's playlist is a 404, not a download.
    assert.equal((await t.app.inject({ method: "GET", url: `/api/export/playlists/${adminListId}`, headers: user })).statusCode, 404);
    assert.equal((await t.app.inject({ method: "GET", url: `/api/export/playlists/${playlistId}` })).statusCode, 401);

    const zip = await t.app.inject({ method: "GET", url: "/api/export/playlists.zip?format=m3u", headers: user });
    const entries = readZip(zip.rawPayload);
    assert.deepEqual([...entries.keys()], ["Evening_ chill.m3u8"]);

    await t.app.inject({
      method: "POST",
      url: "/api/me/history",
      headers: user,
      payload: { plays: [{ playedAt: Date.now() - 5000, track: { id: "s1", title: "=cmd|' /C calc'!A0", artists: [{ id: "a", name: "Artist" }] } }] },
    });
    const csv = await t.app.inject({ method: "GET", url: "/api/export/history?format=csv", headers: user });
    assert.ok(csv.body.includes(",'=cmd|' /C calc'!A0,Artist,"));
    const json = await t.app.inject({ method: "GET", url: "/api/export/history?format=json", headers: user });
    assert.equal((json.json() as { count: number }).count, 1);

    // Snapshots: admins only, valid SQLite, safe names, config round trip.
    assert.equal((await t.app.inject({ method: "POST", url: "/api/backup/snapshot", headers: user })).statusCode, 403);
    const made = await t.app.inject({ method: "POST", url: "/api/backup/snapshot", headers: admin });
    assert.equal(made.statusCode, 201);
    const name = (made.json() as { snapshot: { name: string } }).snapshot.name;
    const download = await t.app.inject({ method: "GET", url: `/api/backup/download/${name}`, headers: admin });
    assert.equal(download.rawPayload.subarray(0, 15).toString(), "SQLite format 3");
    assert.equal((await t.app.inject({ method: "GET", url: `/api/backup/download/${name}`, headers: user })).statusCode, 403);
    assert.equal((await t.app.inject({ method: "GET", url: "/api/backup/download/..%2Fmusic.db", headers: admin })).statusCode, 404);
    const overview = (await t.app.inject({ method: "GET", url: "/api/backup", headers: admin })).json() as { snapshots: unknown[]; restore: string; config: { keep: number } };
    assert.equal(overview.snapshots.length, 1);
    assert.match(overview.restore, /secret\.key/);
    const saved = await t.app.inject({ method: "PUT", url: "/api/backup/config", headers: admin, payload: { enabled: true, everyHours: 6, keep: 3 } });
    assert.deepEqual((saved.json() as { config: unknown }).config, { enabled: true, everyHours: 6, keep: 3 });
    assert.equal((await t.app.inject({ method: "DELETE", url: `/api/backup/snapshots/${name}`, headers: admin })).statusCode, 204);
  } finally {
    await t.cleanup();
  }
});