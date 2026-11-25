import MarqueeKit
import SwiftUI

/// A 2:3 poster. With no picture (or while it loads) it shows the poster's own
/// colour with the title in serif, as the web app's `Poster` does.
struct PosterView: View {
    let path: String?
    let color: String?
    let title: String
    var size: TMDBImage.Size = .w342

    var body: some View {
        Color.clear
            .aspectRatio(2.0 / 3.0, contentMode: .fit)
            .overlay { content }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityLabel(title)
    }

    private var content: some View {
        ZStack(alignment: .bottomLeading) {
            Placeholder.fill(title: title, color: color)
            Text(title)
                .font(.titleSerif(size == .w185 ? 10 : 18))
                .foregroundStyle(Color(hex: 0xF7F3EA))
                .padding(size == .w185 ? 4 : 8)
                .lineLimit(4)
                .minimumScaleFactor(0.7)
            if let url = TMDBImage.url(path: path, size: size) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() }
                }
            }
        }
    }
}

enum Placeholder {
    private static let palette: [UInt32] = [0x3A2412, 0x22364A, 0x5A2A22, 0x2E4A3A, 0x3C3A34, 0x4A2A4A, 0x1F3A5A, 0x4A1F1A]

    /// A steady muted colour for a title with no art, picked from its name like the web app does.
    static func fill(title: String, color: String?) -> Color {
        if let color, let hex = parseHex(color) { return mix(hex, with: 0x0A0C10, amount: 0.55) }
        var h: UInt32 = 0
        for scalar in title.utf16 { h = h &* 31 &+ UInt32(scalar) }
        return Color(hex: palette[Int(h % UInt32(palette.count))])
    }

    static func parseHex(_ text: String) -> UInt32? {
        let t = text.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
        guard t.count == 6 else { return nil }
        return UInt32(t, radix: 16)
    }

    /// `amount` of the first colour over the second, like CSS `color-mix`.
    static func mix(_ a: UInt32, with b: UInt32, amount: Double) -> Color {
        func channel(_ shift: UInt32) -> Double {
            let x = Double((a >> shift) & 0xFF), y = Double((b >> shift) & 0xFF)
            return (x * amount + y * (1 - amount)) / 255
        }
        return Color(.sRGB, red: channel(16), green: channel(8), blue: channel(0), opacity: 1)
    }
}

#Preview {
    HStack {
        PosterView(path: nil, color: nil, title: "Dune: Part Two")
        PosterView(path: nil, color: "#3b8fb8", title: "Bluey")
    }
    .padding()
    .background(.ink)
}
