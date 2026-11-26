import MarqueeKit
import SwiftUI

/// The big artwork at the top of Home and title pages: a backdrop full-bleed under the
/// status bar, fading into the page, with the title in serif above a small caps line.
struct BackdropHero: View {
    let path: String?
    let kicker: String
    let title: String
    let detail: String
    /// 0...1 when something is downloading.
    var progress: Double?
    var height: CGFloat = 440

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            backdrop
            LinearGradient(colors: [.clear, Color.ink.opacity(0.8), .ink], startPoint: .init(x: 0.5, y: 0.35), endPoint: .bottom)
            VStack(alignment: .leading, spacing: 8) {
                Text(kicker.uppercased())
                    .font(.caption.weight(.bold))
                    .tracking(1.4)
                    .foregroundStyle(.amberHi)
                Text(title)
                    .font(.titleSerif(48))
                    .foregroundStyle(.textPrimary)
                    .lineLimit(3)
                    .minimumScaleFactor(0.6)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.soft)
                if let progress {
                    ProgressView(value: progress)
                        .progressViewStyle(BarStyle(fill: .white, track: .white.opacity(0.18)))
                        .accessibilityLabel("Progress")
                        .accessibilityValue("\(Int(progress * 100)) percent")
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
            .accessibilityElement(children: .combine)
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .clipped()
    }

    private var backdrop: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0x3A2412), .ink], startPoint: .top, endPoint: .bottom)
            if let url = TMDBImage.url(path: path, size: .w1280) {
                GeometryReader { proxy in
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill().frame(width: proxy.size.width, height: proxy.size.height).clipped()
                        }
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// A thin rounded progress bar.
struct BarStyle: ProgressViewStyle {
    var fill: Color
    var track: Color = .line
    var height: CGFloat = 4

    func makeBody(configuration: Configuration) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule().fill(fill).frame(width: proxy.size.width * (configuration.fractionCompleted ?? 0))
            }
        }
        .frame(height: height)
    }
}

#Preview {
    BackdropHero(path: nil, kicker: "Downloading · 62%", title: "Dune: Part Two", detail: "4K HDR · about 8 min left · asked for by Sam", progress: 0.62)
        .background(.ink)
}

/// A dark fade behind the status bar and floating buttons, shown once a page with artwork at the top
/// has scrolled past it, so the clock and glass buttons never sit on top of busy text.
struct TopFade: ViewModifier {
    /// How far down (in points) the content scrolls before the fade starts; it's fully there 80 points later.
    var after: CGFloat
    @State private var amount: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: CGFloat.self) { geo in min(max((geo.contentOffset.y + geo.contentInsets.top - after) / 80, 0), 1) } action: { _, value in
                amount = value
            }
            .overlay(alignment: .top) {
                LinearGradient(stops: [.init(color: .ink, location: 0), .init(color: .ink.opacity(0.92), location: 0.55), .init(color: .ink.opacity(0), location: 1)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 140)
                    .ignoresSafeArea(edges: .top)
                    .opacity(amount)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
    }
}

extension View {
    func topFade(after: CGFloat) -> some View { modifier(TopFade(after: after)) }
}
