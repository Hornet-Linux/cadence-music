import Foundation

enum ServerAddress {
    /// Turns what the person typed ("music.example.com", "http://10.0.0.5:8787/")
    /// into the server's web player URL, or nil if it isn't a usable address.
    static func playerURL(from input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard var parts = URLComponents(string: text),
              let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = parts.host, !host.isEmpty
        else { return nil }
        parts.path = "/app/"
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }

    /// For an address typed without a scheme that points at a machine on the
    /// local network (a private IP address, localhost, or a .local/.lan/.home
    /// name), the plain-http player URL to try when https fails: such servers
    /// usually have no certificate. Nil for anything else.
    static func lanHTTPFallback(from input: String) -> URL? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains("://"),
              let https = playerURL(from: text),
              var parts = URLComponents(url: https, resolvingAgainstBaseURL: false),
              let host = parts.host, isLocalNetworkHost(host)
        else { return nil }
        parts.scheme = "http"
        return parts.url
    }

    /// True for hosts that are only reachable from the local network (or this
    /// device): private and link-local IP addresses, localhost, single-word
    /// names such as "nas", and .local/.lan/.home style names.
    static func isLocalNetworkHost(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host.isEmpty { return false }
        if host == "localhost" || host.hasSuffix(".localhost") { return true }
        for suffix in [".local", ".lan", ".home", ".internal", ".home.arpa"] where host.hasSuffix(suffix) {
            return true
        }
        if let octets = ipv4Octets(host) { return isPrivate(octets) }
        if host.contains(":") {
            return host == "::1" || host.hasPrefix("fe80:") || host.hasPrefix("fc") || host.hasPrefix("fd")
        }
        return !host.contains(".")
    }

    /// A note for plain-http addresses that reach beyond the local network, where
    /// passwords and music would cross the internet unencrypted. Nil when fine.
    static func plainHTTPWarning(for url: URL) -> String? {
        guard url.scheme?.lowercased() == "http", let host = url.host, !isLocalNetworkHost(host) else { return nil }
        return "This address doesn't use HTTPS, so your password and music would cross the internet unencrypted. "
            + "Only continue if you trust the network, or ask the server's owner to turn on HTTPS."
    }

    private static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let value = Int(part), value <= 255
            else { return nil }
            octets.append(value)
        }
        return octets
    }

    /// Loopback, RFC 1918, link-local, and the 100.64.0.0/10 range VPN overlays such as Tailscale use.
    private static func isPrivate(_ octets: [Int]) -> Bool {
        let first = octets[0]
        let second = octets[1]
        if first == 10 || first == 127 { return true }
        if first == 169 && second == 254 { return true }
        if first == 172 && second >= 16 && second <= 31 { return true }
        if first == 192 && second == 168 { return true }
        if first == 100 && second >= 64 && second <= 127 { return true }
        return false
    }
}
