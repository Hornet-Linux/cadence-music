import XCTest
@testable import Cadence

final class BridgeOriginTests: XCTestCase {
    private let server = URL(string: "https://music.example.com/app/")!

    private func trusted(_ scheme: String, _ host: String, _ port: Int?, server: URL? = nil) -> Bool {
        BridgeOrigin.isTrusted(scheme: scheme, host: host, port: port, server: server ?? self.server)
    }

    func testSameOriginIsTrusted() {
        XCTAssertTrue(trusted("https", "music.example.com", nil))
        XCTAssertTrue(trusted("https", "music.example.com", 0), "WebKit reports 0 for the default port")
        XCTAssertTrue(trusted("https", "music.example.com", 443))
        XCTAssertTrue(trusted("HTTPS", "Music.Example.com", nil), "scheme and host are case-insensitive")
    }

    func testDifferentHostIsRejected() {
        XCTAssertFalse(trusted("https", "evil.example", nil))
        XCTAssertFalse(trusted("https", "example.com", nil))
        XCTAssertFalse(trusted("https", "", nil))
    }

    func testSubdomainsAreRejected() {
        XCTAssertFalse(trusted("https", "evil.music.example.com", nil))
        XCTAssertFalse(trusted("https", "music.example.com.evil.example", nil))
        XCTAssertFalse(trusted("https", "xmusic.example.com", nil))
    }

    func testDifferentPortIsRejected() {
        XCTAssertFalse(trusted("https", "music.example.com", 8443))
        let custom = URL(string: "http://10.0.0.5:8787/app/")!
        XCTAssertTrue(trusted("http", "10.0.0.5", 8787, server: custom))
        XCTAssertFalse(trusted("http", "10.0.0.5", nil, server: custom))
        XCTAssertFalse(trusted("http", "10.0.0.5", 8788, server: custom))
    }

    func testDifferentSchemeIsRejected() {
        XCTAssertFalse(trusted("http", "music.example.com", nil))
        XCTAssertFalse(trusted("http", "music.example.com", 443))
        XCTAssertFalse(trusted("ftp", "music.example.com", 443))
        XCTAssertFalse(trusted("file", "music.example.com", nil))
        XCTAssertFalse(trusted("about", "", nil))
    }

    func testUserinfoTricksAreRejected() {
        // A host that merely looks like the server inside a user-info style string.
        XCTAssertFalse(trusted("https", "music.example.com@evil.example", nil))
        XCTAssertFalse(trusted("https", "music.example.com:443@evil.example", nil))
        // And a server URL with user-info only ever contributes its real host.
        let tricky = URL(string: "https://music.example.com@evil.example/app/")!
        XCTAssertFalse(trusted("https", "music.example.com", nil, server: tricky))
        XCTAssertTrue(trusted("https", "evil.example", nil, server: tricky))
    }

    func testOriginOfURL() {
        XCTAssertEqual(BridgeOrigin.origin(of: server), BridgeOrigin.Origin(scheme: "https", host: "music.example.com", port: 443))
        XCTAssertNil(BridgeOrigin.origin(of: URL(string: "file:///tmp/x")!))
        XCTAssertNil(BridgeOrigin.origin(of: URL(string: "mailto:a@b.c")!))
    }

    func testOriginStringMatchesLocationOrigin() {
        XCTAssertEqual(BridgeOrigin.originString(of: server), "https://music.example.com")
        XCTAssertEqual(BridgeOrigin.originString(of: URL(string: "http://10.0.0.5:8787/app/")!), "http://10.0.0.5:8787")
        XCTAssertEqual(BridgeOrigin.originString(of: URL(string: "https://Music.Example.com:443/")!), "https://music.example.com")
        XCTAssertEqual(BridgeOrigin.originString(of: URL(string: "http://[::1]:8787/")!), "http://[::1]:8787")
    }

    func testBridgeScriptOnlyDefinesTheBridgeOnTheServersOrigin() throws {
        let script = try XCTUnwrap(AIMessageHandler.bridgeScript(serverURL: server))
        XCTAssertTrue(script.contains("location.origin !=="))
        XCTAssertTrue(script.contains("\"https:\\/\\/music.example.com\"") || script.contains("\"https://music.example.com\""))
        XCTAssertTrue(script.contains("window.CadenceNative"))
        // The origin is a JSON string literal, so odd characters can't break out of it.
        let odd = URL(string: "http://host\"x.example/app/")
        if let odd, let escaped = AIMessageHandler.bridgeScript(serverURL: odd) {
            XCTAssertFalse(escaped.contains("host\"x"))
        }
    }
}
