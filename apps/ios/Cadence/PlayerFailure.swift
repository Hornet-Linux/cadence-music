import Foundation
import Network

/// Pure decisions about when the web player failed to load, and what to tell the person.
enum PlayerFailure {
    /// A message for a main-frame HTTP status that means the player is not there, or nil when the page is fine.
    static func message(forHTTPStatus status: Int) -> String? {
        switch status {
        case 404:
            return "The server answered, but it has no web player at /app. Is this a Cadence server, and is it up to date?"
        case 500...599:
            return "The server reported an error (HTTP \(status)). It may be starting up, so try again in a moment."
        default:
            return nil
        }
    }

    /// Load errors that are not failures: the navigation was cancelled, or
    /// replaced by our own decision (WebKit reports that as error 102).
    static func shouldIgnore(domain: String, code: Int) -> Bool {
        if domain == NSURLErrorDomain && code == NSURLErrorCancelled { return true }
        return domain == "WebKitErrorDomain" && code == 102
    }

    /// What to show for a load error: a plain-language reason for network errors, otherwise the system text.
    static func message(domain: String, code: Int, fallback: String) -> String {
        domain == NSURLErrorDomain ? ServerProbe.describe(errorCode: code) : fallback
    }
}

/// True when a connectivity update means the network just came back, so a
/// failed load is worth retrying on its own.
enum NetworkTransition {
    static func shouldRetry(wasOnline: Bool?, isOnline: Bool) -> Bool {
        wasOnline == false && isOnline
    }
}

/// Calls `onBack` whenever the device goes from offline to online. Used only
/// while the "cannot reach your server" card is showing.
final class NetworkMonitor {
    private let monitor = NWPathMonitor()
    private var wasOnline: Bool?
    private let onBack: () -> Void

    init(onBack: @escaping () -> Void) {
        self.onBack = onBack
    }

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            DispatchQueue.main.async { self?.handle(online: online) }
        }
        monitor.start(queue: DispatchQueue(label: "net.hornetlinux.cadencemusic.network"))
    }

    func stop() {
        monitor.cancel()
    }

    private func handle(online: Bool) {
        let retry = NetworkTransition.shouldRetry(wasOnline: wasOnline, isOnline: online)
        wasOnline = online
        if retry { onBack() }
    }
}
