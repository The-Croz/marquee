import MarqueeKit
import SwiftUI

/// One row in a settings list: a tinted icon, its name, and a short status on the right.
/// The status takes a tone, so "1 problem" reads as warn and "All good" as ready, like the web's Settings.
struct SettingsRowLabel: View {
    let icon: String
    var tint: Color = .amber
    let title: String
    var detail: String?
    var detailTone: Tone = .neutral
    /// Shown for rows that leave the app: "↗".
    var external = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityHidden(true)
            Text(title).foregroundStyle(.textPrimary)
            Spacer(minLength: 8)
            if let detail, !detail.isEmpty {
                Text(detail).font(.footnote).foregroundStyle(detailTone == .neutral ? Color.muted : detailTone.color).lineLimit(1)
            }
            if external {
                Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(.dim).accessibilityHidden(true)
            }
        }
        // The whole list row is the touch target, so the label itself can be shorter than 44pt.
        .frame(minHeight: 34)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(external ? "Opens in Safari" : "")
    }
}

/// A row that opens one page of the web app (things the phone leaves to the web).
struct WebSettingsRow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let icon: String
    var tint: Color = .dim
    let title: String
    let path: String

    var body: some View {
        Button {
            Task { openURL(await app.webURL(path)) }
        } label: {
            SettingsRowLabel(icon: icon, tint: tint, title: title, external: true)
        }
        .buttonStyle(.plain)
    }
}

/// A grey section heading in the app's style (not shouted in capitals).
struct SettingsHeader: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(.footnote.weight(.semibold)).foregroundStyle(.muted).textCase(nil)
    }
}

extension AppModel {
    /// The address of one page of the web app, at whichever address the phone is using now.
    func webURL(_ path: String) async -> URL {
        let base = await client.activeAddress
        return URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) ?? base
    }
}
