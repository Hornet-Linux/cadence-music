import Foundation
import WebKit

/// Decides which pages may talk to the app's native bridges (the "cadence"
/// change-server handler and the "cadenceAI" Apple Intelligence handler).
/// Only the configured server's own pages qualify: the web view can end up on
/// other sites through links or sign-in redirects, and those must not be able
/// to use Apple Intelligence or switch the server.
enum BridgeOrigin {
    /// scheme, host and port, normalised so equal origins compare equal.
    struct Origin: Equatable {
        let scheme: String
        let host: String
        let port: Int
    }

    static func defaultPort(for scheme: String) -> Int? {
        switch scheme {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    /// Builds an origin from the pieces WebKit reports. A port of 0 or nil means
    /// the scheme's default. Only http and https qualify.
    static func origin(scheme: String, host: String, port: Int?) -> Origin? {
        let scheme = scheme.lowercased()
        // Some Foundation versions return IPv6 hosts with their brackets, others without.
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        guard let standard = defaultPort(for: scheme), !host.isEmpty else { return nil }
        let effective = (port == nil || port == 0) ? standard : port!
        return Origin(scheme: scheme, host: host, port: effective)
    }

    static func origin(of url: URL) -> Origin? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme, let host = parts.host
        else { return nil }
        return origin(scheme: scheme, host: host, port: parts.port)
    }

    /// True when a frame with this scheme/host/port belongs to the server.
    static func isTrusted(scheme: String, host: String, port: Int?, server: URL) -> Bool {
        guard let candidate = origin(scheme: scheme, host: host, port: port),
              let expected = origin(of: server)
        else { return false }
        return candidate == expected
    }

    /// Messages count only when they come from the main frame at the
    /// server's origin. Subframes are refused (the player uses none).
    static func isTrusted(_ frame: WKFrameInfo, server: URL) -> Bool {
        let origin = frame.securityOrigin
        return frame.isMainFrame
            && isTrusted(scheme: origin.`protocol`, host: origin.host, port: origin.port, server: server)
    }

    /// The server's origin the way a page's `location.origin` spells it
    /// ("https://music.example.com", "http://10.0.0.5:8787"), for the injected script.
    static func originString(of url: URL) -> String? {
        guard let o = origin(of: url) else { return nil }
        let host = o.host.contains(":") ? "[\(o.host)]" : o.host
        let port = o.port == defaultPort(for: o.scheme) ? "" : ":\(o.port)"
        return "\(o.scheme)://\(host)\(port)"
    }
}
