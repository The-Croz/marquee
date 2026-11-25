import Foundation

/// Where a title stands for the person looking at it.
public enum CardState: WireString {
    case inLibrary, downloading, pending, approved, declined, none
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "in_library": self = .inLibrary
        case "downloading": self = .downloading
        case "pending": self = .pending
        case "approved": self = .approved
        case "declined": self = .declined
        case "none": self = .none
        default: self = .unknown(wire)
        }
    }

    public var wire: String {
        switch self {
        case .inLibrary: "in_library"
        case .downloading: "downloading"
        case .pending: "pending"
        case .approved: "approved"
        case .declined: "declined"
        case .none: "none"
        case .unknown(let text): text
        }
    }
}

public struct DiscoverCard: Codable, Hashable, Sendable, Identifiable {
    public var kind: String
    public var tmdbId: Int
    public var title: String
    public var year: Int?
    public var posterPath: String?
    public var backdropPath: String?
    public var overview: String
    public var score: Double?
    public var genres: [String]
    public var state: CardState
    public var libraryId: Int?
    /// "New", "Coming", "Trending".
    public var badge: String?

    public var id: String { "\(kind)-\(tmdbId)" }
    public var isMovie: Bool { kind == "movie" }
}

public struct DiscoverRow: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var subtitle: String?
    public var items: [DiscoverCard]
}

public struct ServiceChip: Codable, Hashable, Sendable, Identifiable {
    public var key: String
    public var name: String

    public var id: String { key }
}

public struct DiscoverPage: Codable, Hashable, Sendable {
    public var type: String
    public var service: String
    public var services: [ServiceChip]
    public var hero: [DiscoverCard]
    public var rows: [DiscoverRow]
    public var genres: [String]
    public var genre: String?
}

public struct DiscoverSearchResults: Codable, Hashable, Sendable {
    public var results: [DiscoverCard]
}

public struct TitleDetails: Codable, Hashable, Sendable {
    public struct Release: Codable, Hashable, Sendable {
        public var kind: String
        public var date: String
    }

    public struct HomeRelease: Codable, Hashable, Sendable {
        public var date: String
        public var known: Bool
    }

    public var releaseDate: String?
    /// False for a movie not out yet, or a show whose first episode hasn't aired.
    public var released: Bool
    public var releases: [Release]
    public var status: String?
    public var score: Double?
    public var votes: Int
    public var directors: [String]
    public var networks: [String]
    public var seasonCount: Int?
    public var episodeCount: Int?
    public var nextAirDate: String?
    /// "announced", "cinemas" or "out".
    public var stage: String
    public var homeRelease: HomeRelease?
}

public struct CastMember: Codable, Hashable, Sendable, Identifiable {
    public var id: Int?
    public var name: String
    public var character: String?
    public var profilePath: String?

    public var key: String { "\(id ?? 0)-\(name)" }
}

public struct SeasonState: Codable, Hashable, Sendable, Identifiable {
    public var season: Int
    public var episodeCount: Int
    public var state: CardState

    public var id: Int { season }
}

public struct DiscoverTitle: Codable, Hashable, Sendable {
    public struct Provider: Codable, Hashable, Sendable {
        public var name: String
        public var logoPath: String?
    }

    public struct Ratings: Codable, Hashable, Sendable {
        public struct Score: Codable, Hashable, Sendable {
            public var score: Double
            public var votes: Int
        }

        public var tmdb: Score?
        public var imdb: Score?
        public var rottenTomatoes: Int?
        public var metacritic: Int?
    }

    public struct Collection: Codable, Hashable, Sendable {
        public var tmdbId: Int
        public var name: String
    }

    public var details: TitleDetails
    public var card: DiscoverCard
    public var tagline: String?
    public var runtime: Int?
    public var certification: String?
    public var genres: [String]
    /// A YouTube video key.
    public var trailerKey: String?
    public var cast: [CastMember]
    public var providers: [String]
    public var watchOn: [Provider]
    public var ratings: Ratings
    public var seasons: [SeasonState]
    public var similar: DiscoverRow?
    /// This person's own open request for it.
    public var request: RequestView?
    public var canRequest: Bool
    /// Plain words for why not.
    public var note: String?
    public var collection: Collection?
}

public struct SeasonPreview: Codable, Hashable, Sendable {
    public struct Episode: Codable, Hashable, Sendable, Identifiable {
        public var episode: Int
        public var title: String?
        public var airDate: String?
        public var overview: String?
        public var aired: Bool

        public var id: Int { episode }
    }

    public var season: Int
    public var episodes: [Episode]
}

// MARK: Calendar

public struct CalendarItem: Codable, Hashable, Sendable, Identifiable {
    public var kind: String
    public var seriesId: Int?
    public var movieId: Int?
    public var show: String
    public var posterPath: String?
    public var season: Int
    public var episode: Int
    public var title: String?
    public var airDate: String
    /// have, downloading, missing, coming or not_watched (the show isn't Wanted).
    public var state: String
    /// What happens next, in plain words.
    public var note: String

    public var id: String { "\(kind)-\(seriesId ?? movieId ?? 0)-\(season)-\(episode)-\(airDate)" }
}

public struct CalendarView: Codable, Hashable, Sendable {
    public var from: String
    public var to: String
    public var today: String
    public var items: [CalendarItem]
}
