/** Themes an overlay link can ask for with ?theme=. */
export const OVERLAY_THEMES = ["calm", "light", "minimal", "bar"] as const;
export type OverlayTheme = (typeof OVERLAY_THEMES)[number];

/**
 * Locks the overlay page down: it runs only its own inline script, talks only to its own
 * server, and may show pictures from https addresses. It must not be framed, and the
 * link (which holds the secret) is never sent along as a referrer.
 */
export const OVERLAY_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * A self-contained now-playing page for an OBS Browser Source (or any browser). Transparent
 * background, updated live from <this path>/events with a polling fallback. Text is only ever
 * inserted with textContent, never as HTML.
 *
 * Options in the address: theme=calm|light|minimal|bar, art=0 to hide the cover,
 * scale=0.5..3 to resize, align=right to put the card on the right, progress=0 to hide the bar.
 */
export const OVERLAY_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Now playing</title>
<style>
:root {
  --scale: 1;
  --ink: #e9e7e3;
  --ink-soft: #b7b3ac;
  --card: rgba(26, 28, 31, 0.78);
  --edge: rgba(255, 255, 255, 0.08);
  --track: rgba(255, 255, 255, 0.16);
  --fill: #c9c3b6;
  --font: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
}
html[data-theme="light"] {
  --ink: #26282b;
  --ink-soft: #62666b;
  --card: rgba(246, 244, 240, 0.9);
  --edge: rgba(0, 0, 0, 0.08);
  --track: rgba(0, 0, 0, 0.12);
  --fill: #6b7a72;
}
html, body { margin: 0; padding: 0; background: transparent !important; overflow: hidden; font-family: var(--font); color: var(--ink); }
body { width: 100vw; height: 100vh; }
#stage { position: absolute; left: 0; right: 0; bottom: 0; top: 0; display: flex; align-items: flex-end; padding: calc(24px * var(--scale)); box-sizing: border-box; }
html[data-align="right"] #stage { justify-content: flex-end; }
#card {
  display: flex; align-items: center; gap: calc(14px * var(--scale));
  max-width: calc(560px * var(--scale)); min-width: calc(260px * var(--scale));
  padding: calc(12px * var(--scale)); box-sizing: border-box;
  background: var(--card); border: 1px solid var(--edge); border-radius: calc(14px * var(--scale));
  opacity: 0; transform: translateY(calc(6px * var(--scale)));
  transition: opacity 0.6s ease, transform 0.6s ease;
}
#card.show { opacity: 1; transform: none; }
#art { width: calc(64px * var(--scale)); height: calc(64px * var(--scale)); border-radius: calc(8px * var(--scale)); object-fit: cover; flex: none; background: var(--track); }
#art[hidden] { display: none; }
#text { min-width: 0; flex: 1; }
#title { font-size: calc(18px * var(--scale)); font-weight: 600; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#artists { font-size: calc(14px * var(--scale)); color: var(--ink-soft); margin-top: calc(2px * var(--scale)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#bar { height: calc(3px * var(--scale)); border-radius: 2px; background: var(--track); margin-top: calc(9px * var(--scale)); overflow: hidden; }
#bar[hidden] { display: none; }
#fill { height: 100%; width: 0; background: var(--fill); }
#paused { font-size: calc(11px * var(--scale)); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-soft); margin-top: calc(4px * var(--scale)); }
#paused[hidden] { display: none; }
html[data-theme="minimal"] #card { background: none; border: 0; padding: 0; text-shadow: 0 1px 6px rgba(0, 0, 0, 0.55); }
html[data-theme="minimal"] #art { box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); }
html[data-theme="bar"] #stage { padding: 0; }
html[data-theme="bar"] #card { max-width: none; width: 100%; border-radius: 0; border-left: 0; border-right: 0; border-bottom: 0; padding: calc(12px * var(--scale)) calc(24px * var(--scale)); }
@media (prefers-reduced-motion: reduce) { #card { transition: none; } }
</style>
</head>
<body>
<div id="stage">
  <div id="card" role="status" aria-live="polite">
    <img id="art" alt="" hidden referrerpolicy="no-referrer">
    <div id="text">
      <div id="title"></div>
      <div id="artists"></div>
      <div id="bar"><div id="fill"></div></div>
      <div id="paused" hidden>Paused</div>
    </div>
  </div>
</div>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var themes = ["calm", "light", "minimal", "bar"];
  var theme = q.get("theme");
  var root = document.documentElement;
  root.dataset.theme = themes.indexOf(theme) >= 0 ? theme : "calm";
  if (q.get("align") === "right") root.dataset.align = "right";
  var scale = Number(q.get("scale"));
  if (isFinite(scale) && scale >= 0.5 && scale <= 3) root.style.setProperty("--scale", String(scale));
  var wantArt = q.get("art") !== "0";
  var wantBar = q.get("progress") !== "0";

  var card = document.getElementById("card");
  var art = document.getElementById("art");
  var title = document.getElementById("title");
  var artists = document.getElementById("artists");
  var bar = document.getElementById("bar");
  var fill = document.getElementById("fill");
  var paused = document.getElementById("paused");
  bar.hidden = !wantBar;

  var base = location.pathname.replace(/\/+$/, "");
  var snap = null;
  var at = 0;
  var shownKey = "";

  function apply(s) {
    snap = s;
    at = Date.now();
    if (!s || !s.active) { card.classList.remove("show"); return; }
    var key = s.title + "|" + s.artists;
    if (key !== shownKey) {
      shownKey = key;
      title.textContent = s.title;
      artists.textContent = s.artists;
      if (wantArt && /^https:\/\//.test(s.artwork)) { art.referrerPolicy = "no-referrer"; art.src = s.artwork; art.hidden = false; }
      else { art.hidden = true; art.removeAttribute("src"); }
    }
    paused.hidden = s.playing;
    card.classList.add("show");
    draw();
  }

  function draw() {
    if (!snap || !snap.active || !wantBar) return;
    var pos = snap.positionSec + (snap.playing ? (Date.now() - at) / 1000 : 0);
    var pct = snap.durationSec > 0 ? Math.max(0, Math.min(100, (pos / snap.durationSec) * 100)) : 0;
    fill.style.width = pct + "%";
  }
  setInterval(draw, 500);

  function poll() {
    fetch(base + "/now", { cache: "no-store" }).then(function (r) { return r.json(); }).then(apply).catch(function () {});
  }

  var fallback = null;
  function connect() {
    if (!window.EventSource) { fallback = setInterval(poll, 5000); poll(); return; }
    var es = new EventSource(base + "/events");
    es.onmessage = function (e) {
      if (fallback) { clearInterval(fallback); fallback = null; }
      try { apply(JSON.parse(e.data)); } catch (err) {}
    };
    es.onerror = function () {
      // The browser reconnects by itself; poll meanwhile so a dropped stream never freezes the overlay.
      if (!fallback) { fallback = setInterval(poll, 5000); poll(); }
    };
  }
  connect();
})();
</script>
</body>
</html>
`;