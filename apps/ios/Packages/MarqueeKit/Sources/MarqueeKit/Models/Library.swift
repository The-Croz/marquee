import Foundation

/// One title in a Library grid.
public struct LibraryCard: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    /// "movie" or "series".
    public var kind: String
    public var title: String
    public var year: Int?
    public var posterPath: String?
    public var posterColor: String?
    public var certification: String?
    /// Movies: has a file. Shows: has every aired episode.
    public var complete: Bool
    /// "4K HDR", "1080p", "5 of 8 episodes", "Missing".
    public var badge: String
    public var sizeBytes: Double
    public var addedAt: Int64
    /// Marquee looks for it by itself.
    public var wanted: Bool
    public var looking: Bool
    public var watching: Bool

    public var isMovie: Bool { kind == "movie" }
}

public struct LibraryList: Codable, Hashable, Sendable {
    public var items: [LibraryCard]
}

public struct QualityView: Codable, Hashable, Sendable {
    public var resolution: String?
    public var source: String?
    public var hdr: String?
    public var codec: String?
    public var group: String?
    /// "4K HDR", "1080p".
    public var label: String
}

public struct MediaFileView: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var path: String
    public var sizeBytes: Double
    public var quality: QualityView
    public var addedAt: Int64
}

public struct SearchResult: Codable, Hashable, Sendable, Identifiable {
    public var kind: String
    public var tmdbId: Int
    public var title: String
    public var year: Int?
    public var posterPath: String?
    public var overview: String
    /// The Marquee id when it's already in your library.
    public var libraryId: Int?

    public var id: String { "\(kind)-\(tmdbId)" }
}

public struct SearchResults: Codable, Hashable, Sendable {
    public var results: [SearchResult]
}

public struct ProfileSummary: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var kind: String
    public var key: String
    public var name: String
    public var description: String
    public var titles: Int
}

public struct ProfilesView: Codable, Hashable, Sendable {
    public var profiles: [ProfileSummary]
}

public struct WatchLink: Codable, Hashable, Sendable, Identifiable {
    public var server: String
    public var url: String

    public var id: String { server }
}

public struct WatchLinks: Codable, Hashable, Sendable {
    public var links: [WatchLink]
}
