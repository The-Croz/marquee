import SwiftUI

/// The "cinematic dark" colors, copied from the web app's `@theme` (apps/web/src/styles.css).
extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

extension ShapeStyle where Self == Color {
    static var ink: Color { Color(hex: 0x0A0C10) }
    static var panel: Color { Color(hex: 0x12151C) }
    static var raised: Color { Color(hex: 0x1A1F29) }
    static var line: Color { Color(hex: 0x1E2430) }
    static var lineStrong: Color { Color(hex: 0x2E3543) }
    static var textPrimary: Color { Color(hex: 0xF3F4F6) }
    static var soft: Color { Color(hex: 0xC3CAD5) }
    static var muted: Color { Color(hex: 0xA3ACBA) }
    static var dim: Color { Color(hex: 0x8A93A3) }
    static var amber: Color { Color(hex: 0xF2B33D) }
    static var amberHi: Color { Color(hex: 0xFFD27A) }
    static var amberInk: Color { Color(hex: 0x1A1206) }
    /// Downloading.
    static var downloadBlue: Color { Color(hex: 0x6AA6FF) }
    /// Ready, watching.
    static var readyTeal: Color { Color(hex: 0x4FD1C5) }
    /// Needs you, stuck.
    static var warn: Color { Color(hex: 0xFF9E6B) }
}

extension Font {
    /// Instrument Serif, for film and show titles only. Scales with Dynamic Type.
    static func titleSerif(_ size: CGFloat) -> Font {
        .custom("InstrumentSerif-Regular", size: size, relativeTo: .largeTitle)
    }
}

/// The plain meaning of a status colour.
enum Tone {
    case downloading, ready, needsYou, neutral

    var color: Color {
        switch self {
        case .downloading: .downloadBlue
        case .ready: .readyTeal
        case .needsYou: .warn
        case .neutral: .muted
        }
    }
}
