import Foundation

/// IDNA host encoding ("bücher.example" -> "xn--bcher-kva.example"), so a
/// server address typed with non-ASCII letters compares equal to the origin
/// WebKit reports, which is always ASCII. This is the RFC 3492 Punycode
/// encoder plus lowercasing; it doesn't apply the full UTS #46 mapping, so a
/// host that needs more than that simply won't match (the bridge stays off).
enum Punycode {
    private static let base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700
    private static let initialBias = 72, initialN = 128

    /// The ASCII form of a host name. ASCII hosts (and IP literals) come back lowercased.
    static func asciiHost(_ host: String) -> String? {
        let decoded = host.removingPercentEncoding ?? host
        let lower = decoded.lowercased()
        if lower.unicodeScalars.allSatisfy({ $0.isASCII }) { return lower }
        var labels: [String] = []
        for label in lower.split(separator: ".", omittingEmptySubsequences: false) {
            let text = String(label)
            if text.unicodeScalars.allSatisfy({ $0.isASCII }) {
                labels.append(text)
            } else {
                guard let encoded = encode(text) else { return nil }
                labels.append("xn--" + encoded)
            }
        }
        return labels.joined(separator: ".")
    }

    private static func adapt(_ delta: Int, _ numPoints: Int, _ firstTime: Bool) -> Int {
        var delta = firstTime ? delta / damp : delta / 2
        delta += delta / numPoints
        var k = 0
        while delta > ((base - tMin) * tMax) / 2 {
            delta /= base - tMin
            k += base
        }
        return k + (base - tMin + 1) * delta / (delta + skew)
    }

    private static func digit(_ d: Int) -> Character {
        Character(UnicodeScalar(UInt8(d < 26 ? d + 97 : d + 22)))
    }

    /// RFC 3492 section 6.3, for one label.
    static func encode(_ input: String) -> String? {
        let scalars = input.unicodeScalars.map { Int($0.value) }
        var output = String(scalars.filter { $0 < 0x80 }.map { Character(UnicodeScalar(UInt8($0))) })
        let basicCount = output.count
        var handled = basicCount
        if basicCount > 0 { output.append("-") }
        var n = initialN, delta = 0, bias = initialBias
        while handled < scalars.count {
            guard let m = scalars.filter({ $0 >= n }).min() else { return nil }
            let (product, overflow) = (m - n).multipliedReportingOverflow(by: handled + 1)
            if overflow { return nil }
            delta += product
            n = m
            for c in scalars {
                if c < n { delta += 1 }
                if c == n {
                    var q = delta
                    var k = base
                    while true {
                        let t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias)
                        if q < t { break }
                        output.append(digit(t + (q - t) % (base - t)))
                        q = (q - t) / (base - t)
                        k += base
                    }
                    output.append(digit(q))
                    bias = adapt(delta, handled + 1, handled == basicCount)
                    delta = 0
                    handled += 1
                }
            }
            delta += 1
            n += 1
        }
        return output
    }
}
