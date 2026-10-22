import SwiftUI
import UIKit

/// A colour as plain numbers, so contrast can be checked in unit tests.
struct RGB: Equatable {
    let red: Double
    let green: Double
    let blue: Double

    /// From 0xRRGGBB.
    init(hex: UInt32) {
        red = Double((hex >> 16) & 0xFF) / 255
        green = Double((hex >> 8) & 0xFF) / 255
        blue = Double(hex & 0xFF) / 255
    }

    /// WCAG relative luminance.
    var luminance: Double {
        func channel(_ value: Double) -> Double {
            value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }

    /// WCAG contrast ratio between two colours (1 to 21).
    static func contrast(_ a: RGB, _ b: RGB) -> Double {
        let lighter = max(a.luminance, b.luminance)
        let darker = min(a.luminance, b.luminance)
        return (lighter + 0.05) / (darker + 0.05)
    }
}

/// The calm, muted colours of the native screens (address screen, error card, launch).
/// Each role has a light and a dark value, and the pair is checked for contrast in tests.
/// The web player brings its own (dark) theme.
enum Palette {
    struct Role {
        let light: UInt32
        let dark: UInt32

        var lightRGB: RGB { RGB(hex: light) }
        var darkRGB: RGB { RGB(hex: dark) }

        /// Follows the system appearance.
        var color: Color {
            let light = self.light
            let dark = self.dark
            return Color(uiColor: UIColor { traits in
                Palette.uiColor(traits.userInterfaceStyle == .dark ? dark : light)
            })
        }
    }

    static let background = Role(light: 0xF6F7F8, dark: 0x121416)
    static let surface = Role(light: 0xFFFFFF, dark: 0x181B1E)
    static let text = Role(light: 0x191C1F, dark: 0xE6E8EA)
    static let secondaryText = Role(light: 0x50585F, dark: 0xA9B0B7)
    static let primary = Role(light: 0x3F5B73, dark: 0x9FB4C7)
    static let onPrimary = Role(light: 0xFFFFFF, dark: 0x14202B)
    static let error = Role(light: 0xA23B35, dark: 0xE5A09A)
    /// Outline of the address field.
    static let outline = Role(light: 0x7A838B, dark: 0x626A72)
    /// What the web view shows before the page paints (the web player's own background).
    static let playerBackground: UInt32 = 0x0D0E11

    static func uiColor(_ hex: UInt32) -> UIColor {
        let rgb = RGB(hex: hex)
        return UIColor(red: CGFloat(rgb.red), green: CGFloat(rgb.green), blue: CGFloat(rgb.blue), alpha: 1)
    }
}

/// The app's mark (bars that shorten, then a dot), drawn so it follows the colour scheme.
struct LogoMark: View {
    private let heights: [CGFloat] = [50, 38, 27, 16]

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            ForEach(0..<4, id: \.self) { index in
                Capsule()
                    .frame(width: 8, height: heights[index])
            }
            Circle().frame(width: 8, height: 8)
        }
        .foregroundColor(Palette.primary.color)
        .accessibilityHidden(true)
    }
}
