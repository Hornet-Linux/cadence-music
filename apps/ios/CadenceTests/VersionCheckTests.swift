import XCTest
@testable import Cadence

final class VersionCheckTests: XCTestCase {
    func testParse() {
        XCTAssertEqual(VersionCheck.parse("1.2.3"), [1, 2, 3])
        XCTAssertEqual(VersionCheck.parse("v0.2.0"), [0, 2, 0])
        XCTAssertEqual(VersionCheck.parse("V1.0"), [1, 0])
        XCTAssertEqual(VersionCheck.parse("1.2.3-beta.1"), [1, 2, 3])
        XCTAssertEqual(VersionCheck.parse("1.2.3+45"), [1, 2, 3])
        XCTAssertEqual(VersionCheck.parse(" 2 "), [2])
    }

    func testParseRejectsNonVersions() {
        XCTAssertNil(VersionCheck.parse("nightly"))
        XCTAssertNil(VersionCheck.parse(""))
        XCTAssertNil(VersionCheck.parse("v"))
        XCTAssertNil(VersionCheck.parse("1..2"))
        XCTAssertNil(VersionCheck.parse("1.2.x"))
        XCTAssertNil(VersionCheck.parse("-1.2"))
        XCTAssertNil(VersionCheck.parse("1.-2"))
    }

    func testIsNewer() {
        XCTAssertTrue(VersionCheck.isNewer("v0.2.0", than: "0.1.1"))
        XCTAssertTrue(VersionCheck.isNewer("1.10.0", than: "1.9.9"), "numeric, not alphabetical")
        XCTAssertTrue(VersionCheck.isNewer("1.0.1", than: "1.0"))
        XCTAssertTrue(VersionCheck.isNewer("2", than: "1.9.9"))
        XCTAssertFalse(VersionCheck.isNewer("1.0.0", than: "1.0"))
        XCTAssertFalse(VersionCheck.isNewer("0.2.0", than: "0.2.0"))
        XCTAssertFalse(VersionCheck.isNewer("0.1.9", than: "0.2.0"))
        XCTAssertFalse(VersionCheck.isNewer("nightly", than: "0.2.0"))
        XCTAssertFalse(VersionCheck.isNewer("v0.3.0", than: "dev"))
    }

    func testShouldCheckAtMostOncePerDay() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        XCTAssertTrue(VersionCheck.shouldCheck(now: now, last: nil))
        XCTAssertFalse(VersionCheck.shouldCheck(now: now, last: now.addingTimeInterval(-60)))
        XCTAssertFalse(VersionCheck.shouldCheck(now: now, last: now.addingTimeInterval(-23 * 3600)))
        XCTAssertTrue(VersionCheck.shouldCheck(now: now, last: now.addingTimeInterval(-24 * 3600)))
        XCTAssertTrue(VersionCheck.shouldCheck(now: now, last: now.addingTimeInterval(-3 * 24 * 3600)))
        XCTAssertTrue(VersionCheck.shouldCheck(now: now, last: now.addingTimeInterval(3600)), "clock went backwards")
    }

    private func release(_ json: String) -> ReleaseInfo? {
        VersionCheck.parseRelease(Data(json.utf8))
    }

    func testParseRelease() {
        let info = release(#"{"tag_name":"v0.3.0","html_url":"https://github.com/Hornet-Linux/cadence-music/releases/tag/v0.3.0","draft":false,"prerelease":false}"#)
        XCTAssertEqual(info?.tag, "v0.3.0")
        XCTAssertEqual(info?.pageURL.absoluteString, "https://github.com/Hornet-Linux/cadence-music/releases/tag/v0.3.0")
        XCTAssertEqual(info?.displayVersion, "0.3.0")
    }

    func testParseReleaseFallsBackToTheReleasesPage() {
        XCTAssertEqual(release(#"{"tag_name":"v0.3.0"}"#)?.pageURL, VersionCheck.releasesPage)
        XCTAssertEqual(release(#"{"tag_name":"v0.3.0","html_url":"https://evil.example/x"}"#)?.pageURL, VersionCheck.releasesPage)
    }

    func testParseReleaseIgnoresDraftsPrereleasesAndJunk() {
        XCTAssertNil(release(#"{"tag_name":"v9.0.0","draft":true}"#))
        XCTAssertNil(release(#"{"tag_name":"v9.0.0","prerelease":true}"#))
        XCTAssertNil(release(#"{"html_url":"https://github.com/x"}"#))
        XCTAssertNil(release(#"{"tag_name":""}"#))
        XCTAssertNil(release("not json"))
        XCTAssertNil(release("[]"))
    }

    func testUpdateCheckerSkipsDevelopmentBuildsAndRemembersTheCheck() async {
        let defaults = UserDefaults(suiteName: "cadence.tests.update.\(UUID().uuidString)")!
        let checker = UpdateChecker(defaults: defaults)
        let release = await checker.check(currentVersion: "dev")
        XCTAssertNil(release, "a non-version build never checks")
        XCTAssertEqual(defaults.double(forKey: "updateLastCheck"), 0)
    }

    func testUpdateCheckerDoesNotRepeatAPromptedRelease() {
        let defaults = UserDefaults(suiteName: "cadence.tests.notified.\(UUID().uuidString)")!
        let checker = UpdateChecker(defaults: defaults)
        let info = ReleaseInfo(tag: "v0.3.0", pageURL: VersionCheck.releasesPage)
        checker.markNotified(info)
        XCTAssertEqual(defaults.string(forKey: "updateNotifiedTag"), "v0.3.0")
    }
}
