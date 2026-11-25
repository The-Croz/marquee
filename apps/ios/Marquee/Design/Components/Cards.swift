import MarqueeKit
import SwiftUI

/// A big number with its label: On the way (blue), Watching (teal), Need you (warn).
struct CountTile: View {
    let count: Int
    let label: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(count)").font(.title2.weight(.bold)).foregroundStyle(tint)
            Text(label).font(.caption).foregroundStyle(.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.line, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// A wide card for something downloading: the artwork behind the title, with a thin bar.
struct ProgressCard: View {
    let backdrop: String?
    let poster: String?
    let title: String
    let progress: Double
    let detail: String

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Placeholder.fill(title: title, color: nil)
            if let url = TMDBImage.url(path: backdrop ?? poster, size: backdrop == nil ? .w342 : .w1280) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() }
                }
            }
            LinearGradient(colors: [.clear, .black.opacity(0.78)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.titleSerif(26)).foregroundStyle(.white).lineLimit(2).minimumScaleFactor(0.7)
                Text(detail).font(.caption).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
                ProgressView(value: progress)
                    .progressViewStyle(BarStyle(fill: .white, track: .white.opacity(0.25)))
            }
            .padding(12)
        }
        .frame(width: 260, height: 146)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityValue("\(Int(progress * 100)) percent. \(detail)")
    }
}

/// One line of plain status in a status colour: "Stuck · nobody is sharing it".
struct StateLine: View {
    let text: String
    var tone: Tone = .neutral

    var body: some View {
        Text(text).font(.caption).foregroundStyle(tone.color).lineLimit(3).fixedSize(horizontal: false, vertical: true)
    }
}

/// A grouped list card (rows inside one rounded panel).
struct PanelCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(Color.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.line, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

/// A grey section title.
struct SectionTitle: View {
    let text: String
    var trailing: (title: String, action: () -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text).font(.title3.weight(.bold)).foregroundStyle(.textPrimary).accessibilityAddTraits(.isHeader)
            Spacer()
            if let trailing {
                Button(trailing.title, action: trailing.action).font(.subheadline).foregroundStyle(.amber).frame(minHeight: 44)
            }
        }
    }
}

/// Empty and error states: what happened, and what to do.
struct MessageView: View {
    let title: String
    let detail: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 10) {
            Text(title).font(.headline).foregroundStyle(.textPrimary).multilineTextAlignment(.center)
            if !detail.isEmpty {
                Text(detail).font(.subheadline).foregroundStyle(.muted).multilineTextAlignment(.center)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(QuietButtonStyle()).frame(maxWidth: 220).padding(.top, 6)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }
}

/// A grey shape that pulses, while a screen loads.
struct Skeleton: View {
    var width: CGFloat?
    var height: CGFloat
    var radius: CGFloat = 12
    @State private var on = false

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Color.raised)
            .frame(width: width, height: height)
            .opacity(on ? 0.5 : 1)
            .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { on = true } }
            .accessibilityHidden(true)
    }
}

#Preview {
    VStack {
        HStack { CountTile(count: 3, label: "On the way", tint: .downloadBlue); CountTile(count: 1, label: "Watching", tint: .readyTeal); CountTile(count: 3, label: "Need you", tint: .warn) }
        ProgressCard(backdrop: nil, poster: nil, title: "Severance · S2 E8", progress: 0.24, detail: "Downloading · 21 min left")
        StateLine(text: "Stuck · nobody is sharing it", tone: .needsYou)
        MessageView(title: "Can't reach Marquee", detail: "Check you're on your home Wi-Fi.", actionTitle: "Try again") {}
    }
    .padding()
    .background(.ink)
}
