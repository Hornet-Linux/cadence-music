import Foundation

/// What `/api/health` told us about an address.
enum ProbeOutcome: Equatable {
    case cadence(version: String?)
    case failure(String)
}

/// The result of checking a typed address: the origin the server answered from
/// (after redirects, for example "https://music.example.com"), or why not.
enum ConnectOutcome: Equatable {
    case connected(address: String, version: String?)
    case failed(String)
}

/// Checks a typed server address before it is saved, by asking its
/// `/api/health` whether it is a Cadence server. The decisions are pure
/// functions so they can be unit tested without a network.
enum ServerProbe {
    static let expectedName = "cadence-server"
    static let notCadence = "That address answered, but it isn't a Cadence server."

    /// Decide from a `/api/health` response: the HTTP status and the body.
    static func interpret(statusCode: Int, body: Data) -> ProbeOutcome {
        if statusCode == 404 || statusCode == 401 || statusCode == 403 { return .failure(notCadence) }
        guard (200...299).contains(statusCode) else {
            return .failure("The server answered with an error (HTTP \(statusCode)). Try again in a moment.")
        }
        guard let root = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              root["name"] as? String == expectedName,
              root["ok"] as? Bool == true
        else { return .failure(notCadence) }
        let version = (root["version"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return .cadence(version: version)
    }

    /// A person-readable reason for a URLSession failure (`NSURLError` code).
    static func describe(errorCode: Int) -> String {
        let code = URLError.Code(rawValue: errorCode)
        switch code {
        case .cannotFindHost, .dnsLookupFailed:
            return "Couldn't find that server. Check the spelling, and that this device is online."
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
            return "This device is offline. Connect to Wi-Fi or mobile data and try again."
        case .cannotConnectToHost, .networkConnectionLost:
            return "Nothing answered at that address. Is the server running, and is the port right? "
                + "If it's on your home network, also check that Cadence is allowed under Settings, Privacy & Security, Local Network."
        case .timedOut:
            return "The server took too long to answer. Check the address and your connection. "
                + "If it's on your home network, check that Cadence is allowed under Settings, Privacy & Security, Local Network."
        case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
             .clientCertificateRequired:
            return "The server's security certificate was rejected. If it has no certificate, type http:// before the address."
        case .appTransportSecurityRequiresSecureConnection:
            return "This address needs a secure connection. Type https:// before it."
        case .badURL, .unsupportedURL:
            return "That doesn't look like a server address. Try something like music.example.com."
        default:
            return "Couldn't reach the server. Check the address and your connection."
        }
    }

    /// Probe `<origin>/api/health` for a player URL, following redirects (including http to https).
    static func probe(playerURL: URL, session: URLSession = .shared) async -> ConnectOutcome {
        guard let origin = BridgeOrigin.originString(of: playerURL),
              let healthURL = URL(string: origin + "/api/health")
        else { return .failed("That doesn't look like a server address.") }
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed(notCadence) }
            switch interpret(statusCode: http.statusCode, body: Data(data.prefix(64 * 1024))) {
            case .cadence(let version):
                let answeredFrom = http.url.flatMap { BridgeOrigin.originString(of: $0) } ?? origin
                return .connected(address: answeredFrom, version: version)
            case .failure(let message):
                return .failed(message)
            }
        } catch {
            return .failed(describe(errorCode: (error as NSError).code))
        }
    }

    /// Checks what the person typed. A bare local-network address usually has no
    /// certificate, so when https fails there, plain http is tried before giving up.
    static func connect(input: String, session: URLSession = .shared) async -> ConnectOutcome {
        guard let url = ServerAddress.playerURL(from: input) else {
            return .failed("That doesn't look like a server address. Try something like music.example.com.")
        }
        let first = await probe(playerURL: url, session: session)
        if case .connected = first { return first }
        if let fallback = ServerAddress.lanHTTPFallback(from: input) {
            return await probe(playerURL: fallback, session: session)
        }
        return first
    }
}
