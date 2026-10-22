package net.hornetlinux.cadencemusic

/**
 * Injected into the server's pages at document start (and only into pages from the
 * server's own origin; see [PlayerBridge]). Written in ES5, no template literals.
 *
 * It does two things:
 *  1. Defines `window.CadenceNative`, the bridge the web player looks for:
 *       aiName, aiAvailable(), aiChatJson(requestJson), changeServer(), platform
 *  2. Watches the page's Media Session (metadata, playback state, position) and reports
 *     it to the app, which shows it in the media notification and lock screen, and calls
 *     the page's own Media Session action handlers when those controls are used.
 */
object WebScripts {
    const val BRIDGE_NAME = "CadenceAndroid"

    val SOURCE = """
(function () {
  if (window.__cadenceInstalled) return;
  var bridge = window.$BRIDGE_NAME;
  if (!bridge) return;
  window.__cadenceInstalled = true;

  var pending = {};
  var seq = 0;
  bridge.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    var p = pending[msg.id];
    if (!p) return;
    delete pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
  };
  function call(op, request) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      bridge.postMessage(JSON.stringify({ id: id, op: op, request: request }));
    });
  }

  window.CadenceNative = {
    platform: "android",
    aiName: "Gemini Nano",
    aiAvailable: function () { return call("aiAvailable").then(Boolean); },
    aiChatJson: function (requestJson) { return call("aiChat", requestJson); },
    changeServer: function () { bridge.postMessage(JSON.stringify({ op: "changeServer" })); }
  };

  // ---- Media Session -> notification / lock screen --------------------------------
  var ms = navigator.mediaSession;
  var handlers = {};
  var position = null;
  var timer = 0;

  function firstMedia() { return document.querySelector("audio,video"); }

  function report() {
    timer = 0;
    var md = ms && ms.metadata;
    if (!md) {
      bridge.postMessage(JSON.stringify({ op: "media", active: false }));
      return;
    }
    var media = firstMedia();
    var state = ms.playbackState;
    var playing = state === "playing" || (state !== "paused" && !!media && !media.paused);
    var pos = 0, dur = 0;
    if (media && isFinite(media.duration) && media.duration > 0) {
      pos = media.currentTime; dur = media.duration;
    } else if (position) {
      pos = position.position || 0; dur = position.duration || 0;
    }
    var art = "";
    try {
      if (md.artwork && md.artwork.length) art = new URL(md.artwork[md.artwork.length - 1].src, location.href).href;
    } catch (e) {}
    bridge.postMessage(JSON.stringify({
      op: "media", active: true, title: md.title || "", artist: md.artist || "", album: md.album || "",
      artwork: art, playing: playing, position: pos, duration: dur
    }));
  }
  function schedule() { if (!timer) timer = setTimeout(report, 50); }

  if (ms && window.MediaSession) {
    var proto = window.MediaSession.prototype;
    var origSetHandler = proto.setActionHandler;
    proto.setActionHandler = function (action, handler) {
      handlers[action] = handler;
      return origSetHandler.apply(this, arguments);
    };
    ["metadata", "playbackState"].forEach(function (name) {
      var d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.set) return;
      Object.defineProperty(proto, name, {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) { d.set.call(this, v); schedule(); }
      });
    });
    var origSetPosition = proto.setPositionState;
    proto.setPositionState = function (s) {
      position = s || null;
      schedule();
      return origSetPosition.apply(this, arguments);
    };
  }
  ["play", "pause", "seeked", "ratechange", "loadedmetadata", "ended"].forEach(function (t) {
    document.addEventListener(t, schedule, true);
  });

  // Called by the app when a notification / lock-screen control is used.
  window.__cadenceMediaAction = function (action, detail) {
    var handler = handlers[action];
    if (handler) {
      try { handler(Object.assign({ action: action }, detail || {})); } catch (e) {}
      return;
    }
    var media = firstMedia();
    if (!media) return;
    if (action === "play") media.play();
    else if (action === "pause") media.pause();
    else if (action === "seekto" && detail) media.currentTime = detail.seekTime;
  };
})();
""".trimIndent()
}
