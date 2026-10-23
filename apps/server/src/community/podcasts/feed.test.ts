import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpml, NotAFeedError, parseDuration, parseFeed, parseOpml } from "./feed.js";
import { parseXml } from "../_sourcekit/xml.js";
import { normaliseFeedUrl } from "./schema.js";

const URL0 = "https://pod.example/feed.xml";

const GOOD = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
  <title>The &amp; Show</title>
  <link>https://pod.example/</link>
  <language>en</language>
  <itunes:author>Ann Author</itunes:author>
  <description><![CDATA[<p>A <b>great</b> show.</p><p>Second&nbsp;paragraph</p>]]></description>
  <itunes:image href="/art/cover.jpg"/>
  <item>
    <title>Ep 2 &#8211; Newer</title>
    <guid isPermaLink="false">guid-2</guid>
    <pubDate>Tue, 02 Jan 2024 10:00:00 GMT</pubDate>
    <enclosure url="/audio/2.mp3" length="12345" type="audio/mpeg"/>
    <itunes:duration>1:02:03</itunes:duration>
    <itunes:season>2</itunes:season><itunes:episode>5</itunes:episode>
    <content:encoded><![CDATA[<p>Notes &amp; links</p><ul><li>one</li><li>two</li></ul>]]></content:encoded>
    <podcast:chapters url="https://pod.example/ch2.json" type="application/json+chapters"/>
  </item>
  <item>
    <title>Ep 1</title>
    <guid>guid-1</guid>
    <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example/1.m4a?x=1&amp;y=2" type="audio/mp4"/>
    <itunes:duration>754</itunes:duration>
  </item>
  <item><title>No audio</title><guid>noaudio</guid></item>
  <item><title>Script</title><enclosure url="javascript:alert(1)" type="audio/mpeg"/></item>
  <item><title>Wrong type</title><enclosure url="https://x.example/a.pdf" type="application/pdf"/></item>
</channel></rss>`;

test("feed: RSS with iTunes and Podcasting 2.0 tags", () => {
  const f = parseFeed(GOOD, URL0);
  assert.equal(f.title, "The & Show");
  assert.equal(f.author, "Ann Author");
  assert.equal(f.imageUrl, "https://pod.example/art/cover.jpg");
  assert.equal(f.description, "A great show.\nSecond paragraph");
  assert.equal(f.link, "https://pod.example/");
  assert.equal(f.truncated, false);
  assert.deepEqual(f.episodes.map((e) => e.title), ["Ep 2 \u2013 Newer", "Ep 1"]);
  const [e2, e1] = f.episodes;
  assert.equal(e2.audioUrl, "https://pod.example/audio/2.mp3");
  assert.equal(e2.durationSec, 3723);
  assert.equal(e2.season, 2);
  assert.equal(e2.episode, 5);
  assert.equal(e2.size, 12345);
  assert.equal(e2.publishedAt, Date.parse("2024-01-02T10:00:00Z"));
  assert.match(e2.description, /Notes & links\n- one\n- two/);
  assert.equal(e2.chaptersUrl, "https://pod.example/ch2.json");
  assert.equal(e1.audioUrl, "https://cdn.example/1.m4a?x=1&y=2");
  assert.equal(e1.durationSec, 754);
  assert.equal(e1.guid, "guid-1");
});

test("feed: Atom feeds with enclosure links", () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Cast</title><author><name>Al</name></author><link href="https://a.example/"/>
    <entry><title>One</title><id>tag:a,1</id><published>2024-03-01T00:00:00Z</published><link rel="enclosure" href="https://a.example/1.mp3" type="audio/mpeg" length="9"/><summary>sum</summary></entry></feed>`;
  const f = parseFeed(atom, "https://a.example/atom");
  assert.equal(f.title, "Atom Cast");
  assert.equal(f.author, "Al");
  assert.equal(f.episodes.length, 1);
  assert.equal(f.episodes[0].audioUrl, "https://a.example/1.mp3");
  assert.equal(f.episodes[0].guid, "tag:a,1");
});

test("feed: malformed XML keeps what it can read", () => {
  const messy = `<rss><channel><title>Messy & Co <title>
    <item><title>Fine<enclosure url="https://m.example/1.mp3" type="audio/mpeg"></item>
    <item><title>a < b</title><enclosure url=https://m.example/2.mp3 type=audio/mpeg />
    </wrong></item>
    <item><title>Cut off</title><enclosure url="https://m.example/3.mp3" type="audio/mpeg"`;
  const f = parseFeed(messy, URL0);
  assert.ok(f.episodes.length >= 2, `got ${f.episodes.length}`);
  assert.ok(f.episodes.some((e) => e.audioUrl === "https://m.example/2.mp3"));
  assert.ok(f.episodes.every((e) => e.audioUrl.startsWith("https://m.example/")));
});

test("feed: not a feed throws; HTML, JSON and empty documents are refused", () => {
  for (const doc of ["", "plain text", "<html><body><h1>Hi</h1></body></html>", '{"feed": true}', "<?xml version='1.0'?><svg/>"]) {
    assert.throws(() => parseFeed(doc, URL0), NotAFeedError, doc);
  }
});

test("XML safety: DOCTYPE entities are never defined or expanded, so entity bombs and external entities do nothing", () => {
  const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [
    <!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
    <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
    <!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY remote SYSTEM "http://169.254.169.254/latest/meta-data/">
  ]><rss><channel><title>&lol3;&xxe;&remote;</title><item><title>t</title><enclosure url="https://x.example/a.mp3" type="audio/mpeg"/></item></channel></rss>`;
  const started = Date.now();
  const f = parseFeed(bomb, URL0);
  assert.ok(Date.now() - started < 500);
  assert.equal(f.title, "&lol3;&xxe;&remote;", "unknown entities stay literal text");
  assert.ok(!f.title.includes("root:") && !f.title.includes("lollol"));
  assert.equal(f.episodes.length, 1);
});

test("XML safety: absurd nesting and element counts are capped without blowing the stack", () => {
  const deep = "<rss><channel><title>deep</title>" + "<a>".repeat(200_000) + "x" + "</a>".repeat(200_000) + "</channel></rss>";
  const f = parseFeed(deep, URL0);
  assert.equal(f.title, "deep");
  const many = "<rss><channel><title>many</title>" + '<item><title>t</title><enclosure url="https://x.example/a.mp3" type="audio/mpeg"/></item>'.repeat(20_000) + "</channel></rss>";
  assert.equal(parseFeed(many, URL0, { maxItems: 50 }).episodes.length, 50);
  assert.equal(parseFeed(many, URL0, { maxItems: 50 }).truncated, true);
  const flood = parseXml("<a/>".repeat(500), { maxNodes: 100 });
  assert.equal(flood.truncated, true);
  assert.ok(flood.root.children.length <= 100);
});

test("feed: durations and addresses", () => {
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("42:10"), 2530);
  assert.equal(parseDuration("3600"), 3600);
  assert.equal(parseDuration("12.5"), 13);
  assert.equal(parseDuration("soon"), 0);
  assert.equal(parseDuration(undefined), 0);
  assert.equal(normaliseFeedUrl("feed://pod.example/rss"), "http://pod.example/rss");
  assert.equal(normaliseFeedUrl("itpc://pod.example/rss"), "http://pod.example/rss");
  assert.equal(normaliseFeedUrl("pod.example/rss#frag"), "https://pod.example/rss");
  assert.equal(normaliseFeedUrl("https://u:p@pod.example/rss"), null);
  assert.equal(normaliseFeedUrl("file:///etc/passwd"), null);
  assert.equal(normaliseFeedUrl("javascript:alert(1)"), null);
  assert.equal(normaliseFeedUrl(""), null);
});

test("OPML: nested folders are flattened, duplicates and non-http entries dropped, export escapes", () => {
  const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>x</title></head><body>
    <outline text="Folder"><outline type="rss" text="A &amp; B" xmlUrl="https://a.example/feed"/><outline type="rss" text="A again" xmlUrl="https://a.example/feed"/></outline>
    <outline type="rss" title="C" xmlUrl="http://c.example/rss"/><outline text="Bad" xmlUrl="file:///etc/passwd"/><outline text="No url"/></body></opml>`;
  assert.deepEqual(parseOpml(opml), [
    { title: "A & B", feedUrl: "https://a.example/feed" },
    { title: "C", feedUrl: "http://c.example/rss" },
  ]);
  const out = buildOpml([{ title: 'Q "&" <x>', feedUrl: "https://a.example/f?a=1&b=2", link: "https://a.example/" }]);
  assert.match(out, /xmlUrl="https:\/\/a\.example\/f\?a=1&amp;b=2"/);
  assert.match(out, /text="Q &quot;&amp;&quot; &lt;x&gt;"/);
  assert.deepEqual(parseOpml(out), [{ title: 'Q "&" <x>', feedUrl: "https://a.example/f?a=1&b=2" }]);
});