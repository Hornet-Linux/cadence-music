import Foundation

/// A GitHub release, as much of it as the update prompt needs.
struct ReleaseInfo: Equatable {
    let tag: String
    let pageURL: URL

    /// The tag without a leading "v", for showing to people.
    var displayVersion: String {
        tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
    }
}

/// Pure helpers for the "a newer version is available" prompt, kept free of
/// UI and networking so they can be unit tested.
enum VersionCheck {
    static let latestReleaseAPI = URL(string: "https://api.github.com/repos/Hornet-Linux/cadence-music/releases/latest")!
    static let releasesPage = URL(string: "https://github.com/Hornet-Linux/cadence-music/releases/latest")!
    static let checkInterval: TimeInterval = 24 * 60 * 60

    /// Numeric parts of a version such as "v1.2.3" or "1.2.3-beta.1" (a
    /// pre-release or build suffix is ignored). Nil for tags that are not
    /// versions at all, such as "nightly".
    static func parse(_ version: String) -> [Int]? {
        var core = version.trimmingCharacters(in: .whitespacesAndNewlines)
        if core.hasPrefix("v") || core.hasPrefix("V") { core.removeFirst() }
        if let cut = core.firstIndex(where: { $0 == "-" || $0 == "+" }) { core = String(core[core.startIndex..<cut]) }
        guard !core.isEmpty else { return nil }
        var numbers: [Int] = []
        for part in core.split(separator: ".", omittingEmptySubsequences: false) {
            guard !part.isEmpty, part.allSatisfy({ $0.isASCII && $0.isNumber }), let value = Int(part) else { return nil }
            numbers.append(value)
        }
        return numbers
    }

    /// True only if both parse and `latest` is strictly greater than `current`.
    static func isNewer(_ latest: String, than current: String) -> Bool {
        guard let a = parse(latest), let b = parse(current) else { return false }
        for index in 0..<max(a.count, b.count) {
            let x = index < a.count ? a[index] : 0
            let y = index < b.count ? b[index] : 0
            if x != y { return x > y }
        }
        return false
    }

    /// At most one network check per day; a clock that went backwards also triggers one.
    static func shouldCheck(now: Date, last: Date?) -> Bool {
        guard let last = last else { return true }
        if now < last { return true }
        return now.timeIntervalSince(last) >= checkInterval
    }

    /// Reads GitHub's "latest release" response. Nil for drafts, pre-releases and anything malformed.
    static func parseRelease(_ data: Data) -> ReleaseInfo? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        if root["draft"] as? Bool == true || root["prerelease"] as? Bool == true { return nil }
        guard let tag = root["tag_name"] as? String, !tag.isEmpty else { return nil }
        var page = releasesPage
        if let text = root["html_url"] as? String, text.hasPrefix("https://github.com/"), let url = URL(string: text) {
            page = url
        }
        return ReleaseInfo(tag: tag, pageURL: page)
    }
}

/// Looks at most once a day for a newer release on GitHub. Sideloaded apps
/// can't update themselves, so this only tells the person; they open the
/// release page and install it. Offline or any error means "no prompt".
struct UpdateChecker {
    private let defaults: UserDefaults
    private let session: URLSession
    private let lastCheckKey = "updateLastCheck"
    private let notifiedTagKey = "updateNotifiedTag"

    init(defaults: UserDefaults = .standard, session: URLSession = .shared) {
        self.defaults = defaults
        self.session = session
    }

    /// A release newer than `currentVersion` that the person hasn't already
    /// been told about, or nil.
    func check(currentVersion: String, now: Date = Date()) async -> ReleaseInfo? {
        guard VersionCheck.parse(currentVersion) != nil else { return nil } // dev builds
        let storedTime = defaults.double(forKey: lastCheckKey)
        let last: Date? = storedTime > 0 ? Date(timeIntervalSince1970: storedTime) : nil
        guard VersionCheck.shouldCheck(now: now, last: last) else { return nil }
        guard let release = await fetchLatest() else { return nil }
        // Only a completed check counts, so being offline retries next launch instead of waiting a day.
        defaults.set(now.timeIntervalSince1970, forKey: lastCheckKey)
        guard VersionCheck.isNewer(release.tag, than: currentVersion) else { return nil }
        if defaults.string(forKey: notifiedTagKey) == release.tag { return nil }
        return release
    }

    /// Remember that the person saw the prompt for this release, so it isn't repeated.
    func markNotified(_ release: ReleaseInfo) {
        defaults.set(release.tag, forKey: notifiedTagKey)
    }

    private func fetchLatest() async -> ReleaseInfo? {
        var request = URLRequest(url: VersionCheck.latestReleaseAPI)
        request.timeoutInterval = 8
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Cadence-iOS", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return VersionCheck.parseRelease(data)
        } catch {
            return nil
        }
    }
}
