import { test } from "node:test";
import assert from "node:assert/strict";
import { guardedLookup, isBlockedAddress, type NetPolicy } from "./netguard.js";
import { NetError, request, fetchText } from "./http.js";
import { fake } from "./testkit.js";

test("isBlockedAddress: private, loopback, link-local and reserved space is blocked", () => {
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:7f00:1",
    "64:ff9b::7f00:1", "2002:7f00:1::1", "2001:db8::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "not-an-ip", "",
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test("isBlockedAddress: public addresses pass", () => {
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.255.255", "193.0.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("request: refuses loopback, private and metadata addresses, odd spellings of them, and non-http schemes", async () => {
  for (const url of [
    "http://127.0.0.1:9/", "http://localhost/", "http://foo.localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
    "http://2130706433/", "http://0x7f.1/", "http://127.1/", "http://10.0.0.5/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/",
  ]) {
    await assert.rejects(request(url, { headerTimeoutMs: 500 }), (e: unknown) => e instanceof NetError && e.kind === "blocked", url);
  }
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/", "http://user:pw@example.com/", "not a url"]) {
    await assert.rejects(request(url), (e: unknown) => e instanceof NetError && e.kind === "protocol", url);
  }
});

test("guardedLookup: a name that resolves to loopback is refused at connect time unless exempted", async () => {
  const resolve = (policy: NetPolicy, host: string) =>
    new Promise<unknown>((res) => guardedLookup(policy, 80)(host, { all: true }, (err: unknown, list?: unknown) => res(err ?? list)));
  const blocked = await resolve({}, "localhost");
  assert.ok(blocked instanceof Error && (blocked as NodeJS.ErrnoException).code === "EBLOCKED");
  const exempt = await resolve({ allow: (h, p) => h === "localhost" && p === 80 }, "localhost");
  assert.ok(Array.isArray(exempt) && exempt.length > 0);
  const lan = await resolve({ allowPrivate: true }, "localhost");
  assert.ok(Array.isArray(lan));
});

test("request: every redirect hop is checked; redirects to private addresses are refused", async () => {
  const target = await fake(null, (_req, res) => res.end("secret"));
  const hop = await fake(null, (req, res) => {
    if (req.url === "/to-meta") res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }).end();
    else if (req.url === "/to-loop") res.writeHead(302, { Location: target.url + "/" }).end();
    else if (req.url === "/loop") res.writeHead(302, { Location: "/loop" }).end();
    else res.end("fine");
  });
  const allow = (host: string, port: number) => host === "127.0.0.1" && port === hop.port;
  await assert.rejects(request(hop.url + "/to-meta", { allow }), (e: unknown) => e instanceof NetError && e.kind === "blocked");
  await assert.rejects(request(hop.url + "/to-loop", { allow }), (e: unknown) => e instanceof NetError && e.kind === "blocked");
  assert.equal(target.seen.length, 0, "the private target was never contacted");
  await assert.rejects(request(hop.url + "/loop", { allow, maxRedirects: 3 }), (e: unknown) => e instanceof NetError && e.kind === "redirect");
  const ok = await fetchText(hop.url + "/x", { allow });
  assert.equal(ok.text, "fine");
  await hop.close();
  await target.close();
});

test("request: credentials do not follow a redirect to another origin", async () => {
  const b = await fake(null, (_req, res) => res.end("b"));
  const a = await fake(null, (req, res) => (req.url === "/go" ? res.writeHead(302, { Location: b.url + "/" }).end() : res.end("a")));
  const allow = (host: string, port: number) => host === "127.0.0.1" && (port === a.port || port === b.port);
  await fetchText(a.url + "/go", { allow, headers: { Authorization: "Bearer secret", "X-Auth-Key": "k" } });
  assert.equal(a.seen[0].headers.authorization, "Bearer secret");
  assert.equal(b.seen[0].headers.authorization, undefined);
  assert.equal(b.seen[0].headers["x-auth-key"], undefined);
  await a.close();
  await b.close();
});

test("fetchText: size cap throws, truncate keeps the start, and a compressed bomb is stopped", async () => {
  const { gzipSync } = await import("node:zlib");
  const big = "a".repeat(200_000);
  const srv = await fake(null, (req, res) => {
    if (req.url === "/gz") res.writeHead(200, { "Content-Encoding": "gzip" }).end(gzipSync(Buffer.alloc(50_000_000)));
    else if (req.url === "/endless") {
      res.writeHead(200);
      const t = setInterval(() => res.write(big), 1);
      res.on("close", () => clearInterval(t));
    } else res.end(big);
  });
  const allow = (host: string, port: number) => host === "127.0.0.1" && port === srv.port;
  await assert.rejects(fetchText(srv.url + "/", { allow, maxBytes: 1000 }), (e: unknown) => e instanceof NetError && e.kind === "too_large");
  const cut = await fetchText(srv.url + "/", { allow, maxBytes: 1000, truncate: true });
  assert.equal(cut.text.length, 1000);
  assert.equal(cut.truncated, true);
  await assert.rejects(fetchText(srv.url + "/gz", { allow, maxBytes: 1_000_000 }), (e: unknown) => e instanceof NetError && e.kind === "too_large");
  const endless = await fetchText(srv.url + "/endless", { allow, maxBytes: 500_000, truncate: true });
  assert.equal(endless.text.length, 500_000);
  await srv.close();
});

test("fetchText: times out waiting for headers", async () => {
  const srv = await fake(null, () => undefined);
  const allow = (host: string, port: number) => host === "127.0.0.1" && port === srv.port;
  await assert.rejects(fetchText(srv.url + "/", { allow, headerTimeoutMs: 150 }), (e: unknown) => e instanceof NetError && e.kind === "timeout");
  await srv.close();
});