import MarqueeKit
import SwiftUI

/// A round floating button in Liquid Glass. 44pt, always labelled for VoiceOver.
struct GlassCircleButton: View {
    let systemImage: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(label)
    }
}

/// A pill of text on glass, like "3 need you" over the artwork.
struct GlassPill: View {
    let text: String
    var dot: Color?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let dot { Circle().fill(dot).frame(width: 8, height: 8) }
                Text(text).font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
    }
}

/// The amber primary button.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.amberInk)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Color.amber.opacity(isEnabled ? 1 : 0.4), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// An outlined button for second choices.
struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 50)
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.lineStrong, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// A filter chip, like "On the way · 3".
struct Chip: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(selected ? Color.amberHi : Color.soft)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(selected ? Color.amber.opacity(0.14) : .clear, in: Capsule())
                .overlay(Capsule().stroke(selected ? Color.amber : Color.lineStrong, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The signed-in person's picture (or initial) in a glass circle.
struct AvatarButton: View {
    @Environment(AppModel.self) private var app
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Face(name: app.user?.displayName ?? "?", path: app.user?.avatar, size: 34, plain: true)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel("You and settings")
    }
}

/// Someone's picture (from Plex or single sign-on, served by Marquee), or their initial.
struct Face: View {
    @Environment(AppModel.self) private var app
    let name: String
    let path: String?
    var size: CGFloat = 32
    /// No coloured circle behind the initial (inside a glass button).
    var plain = false
    @State private var picture: UIImage?

    private static let cache = NSCache<NSString, UIImage>()

    var body: some View {
        Group {
            if let picture {
                Image(uiImage: picture).resizable().scaledToFill()
            } else {
                Text(name.prefix(1).uppercased())
                    .font(.system(size: size * 0.45, weight: .bold))
                    .foregroundStyle(plain ? Color.white : Color.amberInk)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(plain ? Color.clear : Color.amber)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: path) {
            guard let path else {
                picture = nil
                return
            }
            if let kept = Self.cache.object(forKey: path as NSString) {
                picture = kept
                return
            }
            picture = nil
            guard let data = await app.client.picture(path), let image = UIImage(data: data) else { return }
            Self.cache.setObject(image, forKey: path as NSString)
            picture = image
        }
    }
}
