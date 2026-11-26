import MarqueeKit
import SwiftUI

/// Scores from TMDB, IMDb, Rotten Tomatoes and Metacritic, whichever are known.
/// Used on Discover's sheet and on library title pages, like the web's title page.
struct RatingsRow: View {
    let ratings: DiscoverTitle.Ratings

    var body: some View {
        HStack(spacing: 16) {
            if let s = ratings.tmdb { stat(String(format: "%.1f", s.score), "TMDB") }
            if let s = ratings.imdb { stat(String(format: "%.1f", s.score), "IMDb") }
            if let r = ratings.rottenTomatoes { stat("\(r)%", "Rotten Tomatoes") }
            if let m = ratings.metacritic { stat("\(m)", "Metacritic") }
        }
    }

    var isEmpty: Bool { ratings.tmdb == nil && ratings.imdb == nil && ratings.rottenTomatoes == nil && ratings.metacritic == nil }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.headline).foregroundStyle(.textPrimary)
            Text(label).font(.caption2).foregroundStyle(.muted)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The first dozen cast members, in a row that scrolls sideways.
struct CastRow: View {
    let cast: [CastMember]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Cast")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(cast.prefix(12), id: \.key) { m in
                        VStack(spacing: 4) {
                            Group {
                                if let url = TMDBImage.url(path: m.profilePath, size: .w185) {
                                    AsyncImage(url: url) { phase in if let image = phase.image { image.resizable().scaledToFill() } else { initials(m.name) } }
                                } else { initials(m.name) }
                            }
                            .frame(width: 64, height: 64).clipShape(Circle())
                            Text(m.name).font(.caption2.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(2).multilineTextAlignment(.center).frame(width: 76)
                            if let c = m.character { Text(c).font(.caption2).foregroundStyle(.muted).lineLimit(1).frame(width: 76) }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .scrollClipDisabled()
        }
    }

    /// Two letters on grey while there's no photo (the web does the same).
    private func initials(_ name: String) -> some View {
        Text(name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined())
            .font(.titleSerif(22)).foregroundStyle(.dim)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.raised)
    }
}
