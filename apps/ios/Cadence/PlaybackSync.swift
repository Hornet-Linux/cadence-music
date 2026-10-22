import AVFoundation
import Foundation

/// What to do when the system ends an audio interruption (a phone call, Siri, an alarm).
enum AudioInterruption {
    enum Action: Equatable {
        case none
        case reactivate
    }

    /// `typeValue` and `optionsValue` are the raw values from the interruption notification's userInfo.
    /// Only an interruption that ended with "should resume" needs the session switched back on.
    static func action(typeValue: UInt?, optionsValue: UInt?) -> Action {
        guard let typeValue = typeValue,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue),
              type == .ended
        else { return .none }
        let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue ?? 0)
        return options.contains(.shouldResume) ? .reactivate : .none
    }
}

/// The app's audio session. The web view plays the audio and WebKit publishes
/// the lock screen controls from the page's Media Session; the app only has to
/// declare that it plays music (so it keeps playing with the screen locked and
/// the silent switch on) and keep the session usable after interruptions.
final class AudioSessionController {
    static let shared = AudioSessionController()
    private var observer: NSObjectProtocol?

    /// Sets the category. The session is switched on only when music actually
    /// starts (see `activate`), so opening the app does not cut off other apps' audio.
    func configure() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { [weak self] note in
            self?.handleInterruption(note)
        }
    }

    /// Called when the page starts playing.
    func activate() {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    private func handleInterruption(_ note: Notification) {
        let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
        if AudioInterruption.action(typeValue: type, optionsValue: options) == .reactivate {
            activate()
        }
    }
}

/// A script that keeps the page's idea of "playing" in step with the audio
/// element. When iOS pauses or resumes playback by itself (a call, Siri,
/// unplugged headphones), the element changes but the player's own state does
/// not, so the lock screen play button would do nothing. The script notices
/// the mismatch and runs the page's own Media Session handler, which updates it.
/// It also tells the app when music starts, so the audio session is switched on.
enum PlaybackSync {
    /// Nil if the server URL has no usable origin. The script does nothing on other origins.
    static func script(serverURL: URL) -> String? {
        guard let origin = BridgeOrigin.originString(of: serverURL),
              let data = try? JSONSerialization.data(withJSONObject: origin, options: [.fragmentsAllowed]),
              let literal = String(data: data, encoding: .utf8)
        else { return nil }
        return source.replacingOccurrences(of: "__ORIGIN__", with: literal)
    }

    static let source = """
    (function () {
      if (window.location.origin !== __ORIGIN__) return;
      var session = navigator.mediaSession;
      if (!session || !window.MediaSession || !window.HTMLMediaElement) return;
      var handlers = {};
      var proto = window.MediaSession.prototype;
      var originalSetHandler = proto.setActionHandler;
      proto.setActionHandler = function (action, handler) {
        handlers[action] = handler;
        return originalSetHandler.apply(this, arguments);
      };
      function post(message) {
        try { window.webkit.messageHandlers.cadence.postMessage(message); } catch (e) {}
      }
      function run(action) {
        var handler = handlers[action];
        if (typeof handler !== "function") return;
        try { handler({ action: action }); } catch (e) {}
      }
      var timer = null;
      function reconcile(media) {
        timer = null;
        var state = session.playbackState;
        // Only the element that really plays the music: it has been seen playing while the page said "playing".
        if (state === "playing" && !media.paused) media.__cadenceTrusted = true;
        if (!media.__cadenceTrusted || media.ended || media.readyState === 0) return;
        if (state === "playing" && media.paused) {
          run("pause");
        } else if (state === "paused" && !media.paused && media.readyState >= 3 && media.currentTime > 0) {
          run("play");
        }
      }
      function schedule(media) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { reconcile(media); }, 700);
      }
      function watch(media) {
        if (media.__cadenceWatched) return;
        media.__cadenceWatched = true;
        media.addEventListener("pause", function () { schedule(media); });
        media.addEventListener("play", function () {
          post({ action: "audioActive" });
          schedule(media);
        });
      }
      var originalPlay = window.HTMLMediaElement.prototype.play;
      window.HTMLMediaElement.prototype.play = function () {
        watch(this);
        return originalPlay.apply(this, arguments);
      };
    })();
    """
}
