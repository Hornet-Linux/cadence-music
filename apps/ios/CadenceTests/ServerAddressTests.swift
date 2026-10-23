import XCTest
@testable import Cadence

final class ServerAddressTests: XCTestCase {
    private func player(_ input: String) -> String? {
        ServerAddress.playerURL(from: input)?.absoluteString
    }

    func testBareHostGetsHttpsAndAppPath() {
        XCTAssertEqual(player("music.example.com"), "https://music.example.com/app/")
        XCTAssertEqual(player("  music.example.com  "), "https://music.example.com/app/")
    }

    func testSchemePortAndPathAreHandled() {
        XCTAssertEqual(player("http://10.0.0.5:8787/"), "http://10.0.0.5:8787/app/")
        XCTAssertEqual(player("https://music.example.com/some/where?x=1#y"), "https://music.example.com/app/")
        XCTAssertEqual(player("music.example.com:8443"), "https://music.example.com:8443/app/")
    }

    func testUnusableInputIsRejected() {
        XCTAssertNil(player(""))
        XCTAssertNil(player("   "))
        XCTAssertNil(player("ftp://music.example.com"))
        XCTAssertNil(player("https://"))
        XCTAssertNil(player("music example.com"))
    }

    func testLocalNetworkHosts() {
        for host in ["192.168.1.20", "10.0.0.5", "172.16.0.1", "172.31.255.1", "169.254.1.1", "127.0.0.1",
                     "100.64.0.1", "100.100.100.100", "localhost", "nas", "music.local", "box.lan", "NAS.HOME",
                     "::1", "[::1]", "fd12:3456::1", "fe80::1"] {
            XCTAssertTrue(ServerAddress.isLocalNetworkHost(host), host)
        }
    }

    func testPublicHostsAreNotLocal() {
        for host in ["music.example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.0.1", "100.128.0.1",
                     "192.169.1.1", "11.0.0.1", "1.2.3", "999.1.1.1", "2001:db8::1", ""] {
            XCTAssertFalse(ServerAddress.isLocalNetworkHost(host), host)
        }
    }

    func testLanFallbackOnlyForBareLocalAddresses() {
        XCTAssertEqual(ServerAddress.lanHTTPFallback(from: "192.168.1.20:8787")?.absoluteString, "http://192.168.1.20:8787/app/")
        XCTAssertEqual(ServerAddress.lanHTTPFallback(from: "nas.local")?.absoluteString, "http://nas.local/app/")
        XCTAssertNil(ServerAddress.lanHTTPFallback(from: "https://192.168.1.20:8787"), "an explicit scheme is respected")
        XCTAssertNil(ServerAddress.lanHTTPFallback(from: "http://192.168.1.20:8787"))
        XCTAssertNil(ServerAddress.lanHTTPFallback(from: "music.example.com"))
        XCTAssertNil(ServerAddress.lanHTTPFallback(from: ""))
    }

    func testPlainHttpWarningOnlyBeyondTheLocalNetwork() {
        func warning(_ text: String) -> String? {
            ServerAddress.playerURL(from: text).flatMap { ServerAddress.plainHTTPWarning(for: $0) }
        }
        XCTAssertNotNil(warning("http://music.example.com"))
        XCTAssertNotNil(warning("http://8.8.8.8:8787"))
        XCTAssertNil(warning("https://music.example.com"))
        XCTAssertNil(warning("http://192.168.1.20:8787"))
        XCTAssertNil(warning("http://nas.local"))
        XCTAssertNil(warning("http://localhost:8787"))
    }
}
