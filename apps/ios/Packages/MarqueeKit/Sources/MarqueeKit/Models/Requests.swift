import Foundation

public enum RequestState: WireString {
    case pending, unreleased, searching, looking, downloading, ready, declined
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "pending": self = .pending
        case "unreleased": self = .unreleased
        case "searching": self = .searching
        case "looking": self = .looking
        case "downloading": self = .downloading
        case "ready": self = .ready
        case "declined": self = .declined
        default: self = .unknown(wire)
        }
    }

    public var wire: String {
        switch self {
        case .pending: "pending"
        case .unreleased: "unreleased"
        case .searching: "searching"
        case .looking: "looking"
        case .downloading: "downloading"
        case .ready: "ready"
        case .declined: "declined"
        case .unknown(let text): text
        }
    }
}

public enum RequestKind: WireString {
    case movie, series
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "movie": self = .movie
        case "series": self = .series
        default: self = .unknown(wire)
        }
    }

    public var wire: String {
        switch self {
        case .movie: "movie"
        case .series: "series"
        case .unknown(let text): text
        }
    }
}

public struct RequestView: Codable, Hashable, Sendable, Identifiable {
    public struct Person: Codable, Hashable, Sendable {
        public var id: Int
        public var name: String
    }

    public struct SearchNote: Codable, Hashable, Sendable {
        public var at: Int64
        public var text: String
    }

    public var id: Int
    public var kind: RequestKind
    public var tmdbId: Int
    public var title: String
    public var year: Int?
    public var posterPath: String?
    /// nil = the whole show (or a movie).
    public var seasons: [Int]?
    public var requestedBy: Person?
    public var state: RequestState
    /// A plain sentence for the state.
    public var stateText: String
    public var searchNote: SearchNote?
    public var profile: String?
    public var reason: String?
    public var decidedBy: String?
    public var createdAt: Int64
    public var decidedAt: Int64?
    public var href: String?

    public var created: Date { date(fromMilliseconds: createdAt) }
}

public struct RequestsResponse: Codable, Hashable, Sendable {
    public var items: [RequestView]
}

public struct RequestsSummary: Codable, Hashable, Sendable {
    public var pending: Int
}
