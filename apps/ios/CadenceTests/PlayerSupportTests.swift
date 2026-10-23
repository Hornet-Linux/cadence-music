import AVFoundation
import XCTest
@testable import Cadence

final class PaletteTests: XCTestCase {
    private func contrast(_ foreground: Palette.Role, _ background: Palette.Role) -> (light: Double, dark: Double) {
        (RGB.contrast(foreground.lightRGB, background.lightRGB), RGB.contrast(foreground.darkRGB, background.darkRGB))
    }

    func testTextIsReadableInLightAndDarkMode() {
        let pairs: [(String, Palette.Role, Palette.Role)] = [
            ("text on background", Palette.text, Palette.background),
            ("text on surface", Palette.text, Palette.surface),
            ("secondary on background", Palette.secondaryText, Palette.background),
            ("secondary on surface", Palette.secondaryText, Palette.surface),
            ("button label on button", Palette.onPrimary, Palette.primary),
            ("accent on background", Palette.primary, Palette.background),
            ("error on background", Palette.error, Palette.background),
        ]
        for (name, foreground, background) in pairs {
            let ratio = contrast(foreground, background)
            XCTAssertGreaterThanOrEqual(ratio.light, 4.5, "\(name) in light mode")
            XCTAssertGreaterThanOrEqual(ratio.dark, 4.5, "\(name) in dark mode")
        }
    }

    func testFieldOutlineIsVisible() {
        let ratio = contrast(Palette.outline, Palette.surface)
        XCTAssertGreaterThanOrEqual(ratio.light, 3.0)
        XCTAssertGreaterThanOrEqual(ratio.dark, 3.0)
    }

    func testContrastMath() {
        let black = RGB(hex: 0x000000)
        let white = RGB(hex: 0xFFFFFF)
        XCTAssertEqual(RGB.contrast(black, white), 21, accuracy: 0.01)
        XCTAssertEqual(RGB.contrast(white, white), 1, accuracy: 0.001)
    }
}

final class PlayerFailureTests: XCTestCase {
    func testHttpStatusMessages() {
        XCTAssertNotNil(PlayerFailure.message(forHTTPStatus: 404))
        XCTAssertTrue(PlayerFailure.message(forHTTPStatus: 503)?.contains("503") ?? false)
        XCTAssertNil(PlayerFailure.message(forHTTPStatus: 200))
        XCTAssertNil(PlayerFailure.message(forHTTPStatus: 302))
        XCTAssertNil(PlayerFailure.message(forHTTPStatus: 401))
    }

    func testCancelledLoadsAreNotFailures() {
        XCTAssertTrue(PlayerFailure.shouldIgnore(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
        XCTAssertTrue(PlayerFailure.shouldIgnore(domain: "WebKitErrorDomain", code: 102))
        XCTAssertFalse(PlayerFailure.shouldIgnore(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
        XCTAssertFalse(PlayerFailure.shouldIgnore(domain: "WebKitErrorDomain", code: 101))
    }

    func testNetworkErrorsGetPlainLanguage() {
        let text = PlayerFailure.message(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet, fallback: "x")
        XCTAssertTrue(text.contains("offline"))
        XCTAssertEqual(PlayerFailure.message(domain: "WebKitErrorDomain", code: 100, fallback: "Fallback text"), "Fallback text")
    }

    func testRetryOnlyWhenTheNetworkComesBack() {
        XCTAssertTrue(NetworkTransition.shouldRetry(wasOnline: false, isOnline: true))
        XCTAssertFalse(NetworkTransition.shouldRetry(wasOnline: nil, isOnline: true), "first report is not a change")
        XCTAssertFalse(NetworkTransition.shouldRetry(wasOnline: true, isOnline: true))
        XCTAssertFalse(NetworkTransition.shouldRetry(wasOnline: true, isOnline: false))
        XCTAssertFalse(NetworkTransition.shouldRetry(wasOnline: false, isOnline: false))
    }
}

final class PlaybackSyncTests: XCTestCase {
    func testInterruptionEndedWithShouldResumeReactivates() {
        let ended = AVAudioSession.InterruptionType.ended.rawValue
        let began = AVAudioSession.InterruptionType.began.rawValue
        let resume = AVAudioSession.InterruptionOptions.shouldResume.rawValue
        XCTAssertEqual(AudioInterruption.action(typeValue: ended, optionsValue: resume), .reactivate)
        XCTAssertEqual(AudioInterruption.action(typeValue: ended, optionsValue: 0), .none)
        XCTAssertEqual(AudioInterruption.action(typeValue: ended, optionsValue: nil), .none)
        XCTAssertEqual(AudioInterruption.action(typeValue: began, optionsValue: resume), .none)
        XCTAssertEqual(AudioInterruption.action(typeValue: nil, optionsValue: resume), .none)
        XCTAssertEqual(AudioInterruption.action(typeValue: 99, optionsValue: resume), .none)
    }

    func testScriptIsLimitedToTheServersOrigin() throws {
        let script = try XCTUnwrap(PlaybackSync.script(serverURL: URL(string: "https://music.example.com/app/")!))
        XCTAssertFalse(script.contains("__ORIGIN__"), "the placeholder is replaced")
        XCTAssertTrue(script.contains("location.origin !=="))
        XCTAssertTrue(script.contains("music.example.com"))
        XCTAssertTrue(script.contains("audioActive"))
        XCTAssertTrue(script.contains("setActionHandler"))
    }

    func testScriptNeedsAUsableOrigin() {
        XCTAssertNil(PlaybackSync.script(serverURL: URL(string: "file:///tmp/x")!))
    }
}
