import XCTest
@testable import Cadence

/// Answers URLSession requests from a closure, so the probe can be tested without a network.
final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = StubURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    static func respond(_ request: URLRequest, status: Int = 200, body: String) -> (HTTPURLResponse, Data) {
        let url = request.url ?? URL(string: "https://invalid.example")!
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (response, Data(body.utf8))
    }
}

final class ServerProbeTests: XCTestCase {
    private let healthy = #"{"ok":true,"name":"cadence-server","version":"0.2.0","setupRequired":false}"#

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    private func interpret(_ status: Int, _ body: String) -> ProbeOutcome {
        ServerProbe.interpret(statusCode: status, body: Data(body.utf8))
    }

    func testInterpretAcceptsACadenceServer() {
        XCTAssertEqual(interpret(200, healthy), .cadence(version: "0.2.0"))
        XCTAssertEqual(interpret(200, #"{"ok":true,"name":"cadence-server"}"#), .cadence(version: nil))
        XCTAssertEqual(interpret(200, #"{"ok":true,"name":"cadence-server","version":""}"#), .cadence(version: nil))
    }

    func testInterpretRejectsOtherServers() {
        let notCadence = ProbeOutcome.failure(ServerProbe.notCadence)
        XCTAssertEqual(interpret(200, "<html>hello</html>"), notCadence)
        XCTAssertEqual(interpret(200, #"{"ok":true,"name":"something-else"}"#), notCadence)
        XCTAssertEqual(interpret(200, #"{"ok":false,"name":"cadence-server"}"#), notCadence)
        XCTAssertEqual(interpret(200, #"{"name":"cadence-server"}"#), notCadence)
        XCTAssertEqual(interpret(200, "[]"), notCadence)
        XCTAssertEqual(interpret(404, "nope"), notCadence)
        XCTAssertEqual(interpret(401, ""), notCadence)
        XCTAssertEqual(interpret(403, ""), notCadence)
    }

    func testInterpretReportsServerErrors() {
        guard case .failure(let message) = interpret(502, "bad gateway") else { return XCTFail("expected a failure") }
        XCTAssertTrue(message.contains("502"))
    }

    func testDescribeCoversTheCommonNetworkErrors() {
        func text(_ code: URLError.Code) -> String { ServerProbe.describe(errorCode: code.rawValue) }
        XCTAssertTrue(text(.cannotFindHost).contains("find that server"))
        XCTAssertTrue(text(.dnsLookupFailed).contains("find that server"))
        XCTAssertTrue(text(.notConnectedToInternet).contains("offline"))
        XCTAssertTrue(text(.cannotConnectToHost).contains("Nothing answered"))
        XCTAssertTrue(text(.timedOut).contains("too long"))
        XCTAssertTrue(text(.serverCertificateUntrusted).contains("certificate"))
        XCTAssertTrue(text(.secureConnectionFailed).contains("http://"))
        XCTAssertTrue(text(.badURL).contains("server address"))
        XCTAssertTrue(ServerProbe.describe(errorCode: 12345).contains("reach the server"))
    }

    func testConnectReturnsTheAddressTheServerAnsweredFrom() async {
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://music.example.com/api/health")
            return StubURLProtocol.respond(request, body: self.healthy)
        }
        let outcome = await ServerProbe.connect(input: "music.example.com", session: StubURLProtocol.session())
        XCTAssertEqual(outcome, .connected(address: "https://music.example.com", version: "0.2.0"))
    }

    func testConnectKeepsACustomPort() async {
        StubURLProtocol.handler = { request in StubURLProtocol.respond(request, body: self.healthy) }
        let outcome = await ServerProbe.connect(input: "http://10.0.0.5:8787/app", session: StubURLProtocol.session())
        XCTAssertEqual(outcome, .connected(address: "http://10.0.0.5:8787", version: "0.2.0"))
    }

    func testConnectFlagsAServerThatIsNotCadence() async {
        StubURLProtocol.handler = { request in StubURLProtocol.respond(request, body: "<html>welcome</html>") }
        let outcome = await ServerProbe.connect(input: "example.com", session: StubURLProtocol.session())
        XCTAssertEqual(outcome, .failed(ServerProbe.notCadence))
    }

    func testConnectExplainsAnUnreachableServer() async {
        StubURLProtocol.handler = { _ in throw URLError(.cannotFindHost) }
        let outcome = await ServerProbe.connect(input: "nowhere.example.com", session: StubURLProtocol.session())
        XCTAssertEqual(outcome, .failed(ServerProbe.describe(errorCode: URLError.Code.cannotFindHost.rawValue)))
    }

    func testConnectFallsBackToHttpForABareLocalAddress() async {
        StubURLProtocol.handler = { request in
            if request.url?.scheme == "https" { throw URLError(.secureConnectionFailed) }
            return StubURLProtocol.respond(request, body: self.healthy)
        }
        let outcome = await ServerProbe.connect(input: "192.168.1.20:8787", session: StubURLProtocol.session())
        XCTAssertEqual(outcome, .connected(address: "http://192.168.1.20:8787", version: "0.2.0"))
    }

    func testConnectDoesNotDowngradeAPublicHostToHttp() async {
        StubURLProtocol.handler = { request in
            if request.url?.scheme == "https" { throw URLError(.secureConnectionFailed) }
            return StubURLProtocol.respond(request, body: self.healthy)
        }
        let outcome = await ServerProbe.connect(input: "music.example.com", session: StubURLProtocol.session())
        XCTAssertEqual(outcome, .failed(ServerProbe.describe(errorCode: URLError.Code.secureConnectionFailed.rawValue)))
    }

    func testConnectRejectsAnUnusableAddress() async {
        let outcome = await ServerProbe.connect(input: "", session: StubURLProtocol.session())
        guard case .failed(let message) = outcome else { return XCTFail("expected a failure") }
        XCTAssertTrue(message.contains("server address"))
    }
}
