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
}
