import XCTest
@testable import Cadence

final class AppleIntelligenceTests: XCTestCase {
    private let request = """
    {"messages":[{"role":"system","content":"You are a DJ."},{"role":"user","content":"Pick 3 songs."}],
     "schema":{"type":"object","properties":{"picks":{"type":"array"}},"required":["picks"]},
     "temperature":0.5}
    """

    // These two run anywhere, including the simulator and CI.

    func testPreparesInstructionsPromptAndSchema() throws {
        let prompt = try AppleIntelligence.prepare(requestJSON: request)
        XCTAssertTrue(prompt.instructions.hasPrefix("You are a DJ."))
        XCTAssertTrue(prompt.instructions.contains("JSON Schema"))
        XCTAssertTrue(prompt.instructions.contains("\"required\":[\"picks\"]"))
        XCTAssertEqual(prompt.prompt, "Pick 3 songs.")
        XCTAssertEqual(prompt.temperature, 0.5)
    }

    func testRejectsBadRequests() {
        XCTAssertThrowsError(try AppleIntelligence.prepare(requestJSON: "not json"))
        XCTAssertThrowsError(try AppleIntelligence.prepare(requestJSON: "{\"messages\":[]}"))
    }

    func testAvailabilityAlwaysExplainsItself() {
        let state = AppleIntelligence.availability()
        XCTAssertTrue(state.available || state.reason != nil)
    }

    // Only runs on hardware with Apple Intelligence turned on (an iPhone 15 Pro
    // or newer on iOS 26+, or a supported Mac running the iOS app). Everywhere
    // else it is reported as skipped rather than failing.
    func testGeneratesJSONOnCompatibleHardware() async throws {
        let state = AppleIntelligence.availability()
        try XCTSkipUnless(state.available, "Needs Apple Intelligence: \(state.reason ?? "unavailable")")

        let reply = try await AppleIntelligence.chatJson(requestJSON: """
        {"messages":[{"role":"user","content":"Name two famous songs by Daft Punk, with a one-sentence intro each."}],
         "schema":{"type":"object","properties":{"picks":{"type":"array","items":{"type":"object","properties":{"artist":{"type":"string"},"title":{"type":"string"},"intro":{"type":"string"}}}}},"required":["picks"]}}
        """)
        let start = try XCTUnwrap(reply.firstIndex(of: "{"), "The reply had no JSON: \(reply)")
        let end = try XCTUnwrap(reply.lastIndex(of: "}"), "The reply had no JSON: \(reply)")
        let object = try JSONSerialization.jsonObject(with: Data(reply[start...end].utf8)) as? [String: Any]
        XCTAssertNotNil(object?["picks"] as? [Any], "Expected a picks array in: \(reply)")
    }
}
