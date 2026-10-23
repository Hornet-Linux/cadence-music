import Foundation

/// What the player's web view may load. Plain http is allowed (self-hosters run
/// Cadence on their LAN without certificates), but only to the configured
/// server and local-network addresses; everything else must be https. App
/// Transport Security can't be scoped to an address typed at run time, so the
/// Info.plist allows http and this narrows it: a WebKit content rule list
/// refuses other http loads, and the navigation delegate sends links the
/// listener taps off the server to Safari. Redirects and script navigations
/// (sign-in with Spotify, Apple or the server's single sign-on) stay in the
/// app. Mirrors `WebPolicy` in the Android app.
enum WebPolicy {
    enum Decision: Equatable { case stay, openExternally, block }

    private static let localSuffixes = [".local", ".lan", ".home.arpa", ".internal", ".localhost"]

    /// Loopback, private and link-local addresses, and names that only exist on a home network.
    static func isLocalHost(_ raw: String?) -> Bool {
        guard var host = raw?.lowercased() else { return false }
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        while host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty { return false }
        if host == "localhost" || localSuffixes.contains(where: { host.hasSuffix($0) }) { return true }
        if host.contains(":") {
            return host == "::1" || host.hasPrefix("fc") || host.hasPrefix("fd")
                || ["fe8", "fe9", "fea", "feb"].contains(where: { host.hasPrefix($0) })
        }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4, parts.allSatisfy({ !$0.isEmpty && $0.count <= 3 && $0.allSatisfy(\.isNumber) }) {
            let a = Int(parts[0]) ?? -1, b = Int(parts[1]) ?? -1
            return a == 10 || a == 127 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
                || (a == 169 && b == 254) || (a == 100 && (64...127).contains(b)) // carrier-grade NAT (Tailscale)
        }
        // A single-label name ("nas", "music") only resolves on the local network.
        return !host.contains(".")
    }

    /// scheme://host:port, lowercased, with the scheme's default port filled in.
    private static func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : -1)
        return port < 0 ? nil : "\(scheme)://\(host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))):\(port)"
    }

    static func sameOrigin(_ url: URL, _ server: URL) -> Bool {
        guard let a = origin(url), let b = origin(server) else { return false }
        return a == b
    }

    /// May this URL be fetched? https always; http only to the server or a local address.
    static func allowsLoad(_ url: URL, server: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "https": return true
        case "http": return sameOrigin(url, server) || isLocalHost(url.host)
        default: return true // data:, blob:, about: never reach the network
        }
    }

    static func navigation(_ url: URL, server: URL, userTapped: Bool, mainFrame: Bool) -> Decision {
        let scheme = url.scheme?.lowercased() ?? ""
        if ["about", "blob", "data"].contains(scheme) { return .stay }
        if scheme != "http" && scheme != "https" { return .openExternally } // mailto:, tel:, sms:
        if sameOrigin(url, server) { return .stay }
        if userTapped && mainFrame { return .openExternally }
        return allowsLoad(url, server: server) ? .stay : .block
    }

    /// The WebKit content rule list (JSON) that blocks plain http except to
    /// the server and local addresses. WebKit's url-filter has no `|`, so each
    /// allowed pattern is its own "ignore-previous-rules" rule.
    static func contentRules(server: URL) -> String {
        var allowed = [
            #"^http://localhost[:/]"#, #"^http://127\."#, #"^http://10\."#, #"^http://192\.168\."#,
            #"^http://172\.1[6-9]\."#, #"^http://172\.2[0-9]\."#, #"^http://172\.3[01]\."#, #"^http://169\.254\."#,
            #"^http://100\.6[4-9]\."#, #"^http://100\.[7-9][0-9]\."#, #"^http://100\.1[01][0-9]\."#, #"^http://100\.12[0-7]\."#,
            #"^http://[^/:.]+[:/]"#, // single-label names
            #"^http://\[f[cd]"#, #"^http://\[fe[89ab]"#, #"^http://\[::1\]"#,
        ]
        allowed += localSuffixes.map { #"^http://[^/:]+\#(NSRegularExpression.escapedPattern(for: $0))[:/]"# }
        if server.scheme?.lowercased() == "http", let host = server.host, !host.isEmpty {
            let escaped = NSRegularExpression.escapedPattern(for: host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]")))
            allowed.append(host.contains(":") ? #"^http://\[\#(escaped)\]"# : #"^http://\#(escaped)[:/]"#)
        }
        let rules: [[String: Any]] = [["trigger": ["url-filter": "^http:"], "action": ["type": "block"]]]
            + allowed.map { ["trigger": ["url-filter": $0], "action": ["type": "ignore-previous-rules"]] }
        let data = (try? JSONSerialization.data(withJSONObject: rules, options: [.sortedKeys])) ?? Data("[]".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
