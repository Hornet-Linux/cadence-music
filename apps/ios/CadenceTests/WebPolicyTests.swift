import XCTest
@testable import Cadence

final class WebPolicyTests: XCTestCase {
    private let lan = URL(string: "http://192.168.1.20:8787/app/")!
    private let publicServer = URL(string: "https://music.example.com/app/")!

    func testLocalAddresses() {
        for host in ["localhost", "127.0.0.1", "10.0.0.5", "172.16.3.4", "172.31.255.1", "192.168.1.20", "169.254.1.1",
                     "100.101.102.103", "nas", "nas.local", "music.lan", "box.home.arpa", "::1", "[fd12::1]", "fe80::1"] {
            XCTAssertTrue(WebPolicy.isLocalHost(host), host)
        }
        for host in ["8.8.8.8", "172.32.0.1", "192.169.1.1", "100.128.0.1", "example.com", "music.example.com", "2001:db8::1", ""] {
            XCTAssertFalse(WebPolicy.isLocalHost(host), host)
        }
    }

    func testCleartextOnlyToTheServerOrTheLan() {
        XCTAssertTrue(WebPolicy.allowsLoad(URL(string: "http://192.168.1.20:8787/api/health")!, server: lan))
        XCTAssertTrue(WebPolicy.allowsLoad(URL(string: "http://nas.local/cover.jpg")!, server: publicServer))
        XCTAssertTrue(WebPolicy.allowsLoad(URL(string: "https://i.scdn.co/image/x")!, server: lan))
        XCTAssertFalse(WebPolicy.allowsLoad(URL(string: "http://tracker.example.net/pixel.gif")!, server: lan))
        let plainPublic = URL(string: "http://music.example.org/app/")!
        XCTAssertTrue(WebPolicy.allowsLoad(URL(string: "http://music.example.org/app/x.js")!, server: plainPublic))
    }

    func testTappedLinksOffTheServerOpenInSafari() {
        XCTAssertEqual(WebPolicy.navigation(URL(string: "http://192.168.1.20:8787/app/#/library")!, server: lan, userTapped: true, mainFrame: true), .stay)
        XCTAssertEqual(WebPolicy.navigation(URL(string: "https://github.com/Hornet-Linux")!, server: lan, userTapped: true, mainFrame: true), .openExternally)
        XCTAssertEqual(WebPolicy.navigation(URL(string: "mailto:a@b.c")!, server: lan, userTapped: true, mainFrame: true), .openExternally)
    }

    func testSignInRedirectsStayButNotOverPlainHttp() {
        XCTAssertEqual(WebPolicy.navigation(URL(string: "https://auth.example.com/authorize?x=1")!, server: publicServer, userTapped: false, mainFrame: true), .stay)
        XCTAssertEqual(WebPolicy.navigation(URL(string: "https://accounts.spotify.com/authorize")!, server: publicServer, userTapped: false, mainFrame: true), .stay)
        XCTAssertEqual(WebPolicy.navigation(URL(string: "http://evil.example/phish")!, server: publicServer, userTapped: false, mainFrame: true), .block)
    }

    func testContentRulesAreValidJson() throws {
        let json = WebPolicy.contentRules(server: URL(string: "http://music.example.org:8787/app/")!)
        let rules = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]])
        XCTAssertEqual((rules.first?["action"] as? [String: String])?["type"], "block")
        XCTAssertTrue(json.contains(#"music\\.example\\.org"#))
        for rule in rules {
            let filter = try XCTUnwrap((rule["trigger"] as? [String: String])?["url-filter"])
            XCTAssertFalse(filter.contains("|"), "WebKit's url-filter has no alternation: \(filter)")
        }
    }
}
