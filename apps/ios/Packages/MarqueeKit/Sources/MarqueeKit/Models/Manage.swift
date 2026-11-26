import Foundation

// MARK: Watching

public struct ActivityNow: Codable, Hashable, Sendable {
    public struct Live: Codable, Hashable, Sendable {
        public var server: String
        public var live: Bool
    }

    public var sessions: [NowPlaying]
    public var problems: [String]
    public var live: [Live]?
}

public struct ActivityStats: Codable, Hashable, Sendable {
    public struct Day: Codable, Hashable, Sendable, Identifiable {
        public var day: String
        public var plays: Int
        public var id: String { day }
    }

    public struct Counted: Codable, Hashable, Sendable, Identifiable {
        public var name: String
        public var plays: Int
        public var id: String { name }
    }

    public struct Servers: Codable, Hashable, Sendable {
        public var plex: Int
        public var jellyfin: Int
    }

    public struct LiveStats: Codable, Hashable, Sendable {
        public var streams: Int
        public var watchHours: Double
        public var peakStreams: Int
        public var direct: Int
        public var converted: Int
    }

    public var days: Int
    public var total: Int
    public var last24h: Int
    public var perDay: [Day]
    public var users: [Counted]
    public var movies: [Counted]
    public var shows: [Counted]
    public var servers: Servers
    public var live: LiveStats
}

public struct PersonSummary: Codable, Hashable, Sendable, Identifiable {
    public var name: String
    public var plays: Int
    public var hours: Double
    public var last: Int64?
    public var devices: [String]
    public var id: String { name }
}

public struct PeopleResponse: Codable, Hashable, Sendable {
    public var people: [PersonSummary]
}

// MARK: Health

public struct ConnectionView: Codable, Hashable, Sendable, Identifiable {
    public var key: String
    public var group: String
    public var name: String
    public var to: String?
    /// "ok", "problem", "off"...
    public var tone: String
    public var state: String
    public var fix: String?
    public var detail: String?
    public var id: String { key }
    public var needsYou: Bool { tone == "problem" }
}

public struct DiskView: Codable, Hashable, Sendable, Identifiable {
    public var key: String
    public var label: String
    public var path: String
    public var free: Double?
    public var total: Double?
    public var tone: String
    public var state: String
    public var fix: String?
    public var id: String { key }
    public var needsYou: Bool { tone == "problem" }
}

public struct JobView: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var description: String
    public var every: String
    public var tone: String
    public var running: Bool
    public var off: String?
    public var lastFinishedAt: Int64?
    public var lastOk: Bool?
    public var lastMessage: String?
}

public struct HealthView: Codable, Hashable, Sendable {
    public var checkedAt: Int64
    /// How many rows need you.
    public var problems: Int
    public var connections: [ConnectionView]
    public var disks: [DiskView]
    public var jobs: [JobView]
}

// MARK: Sources, people, library care

public struct SourceView: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String
    public var kind: String
    public var enabled: Bool
    public var priority: Int
    public var `private`: Bool
    public var forMovies: Bool
    public var forTv: Bool
    /// "working", or a plain-word problem code.
    public var state: String
    public var stateLabel: String
    public var stateMessage: String?
    public var fix: String?
    public var checkedAt: Int64?
    public var retryAt: Int64?
    public var isWorking: Bool { state == "working" }
}

public struct SourcesView: Codable, Hashable, Sendable {
    public var sources: [SourceView]
}

public struct UserSummary: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var username: String
    public var displayName: String
    public var role: Role
    public var linked: SessionUser.Linked
    public var createdAt: Int64
    public var lastLoginAt: Int64?
    /// Their requests go straight through (kids: only titles for kids).
    public var skipApproval: Bool
    /// Most requests in 7 days; 0 means no limit.
    public var weeklyLimit: Int
    public var avatar: String?
}

public struct UsersResponse: Codable, Hashable, Sendable {
    public var users: [UserSummary]
}

public struct UnmatchedItem: Codable, Hashable, Sendable, Identifiable {
    public struct Candidate: Codable, Hashable, Sendable, Identifiable {
        public var tmdbId: Int
        public var title: String
        public var year: Int?
        public var posterPath: String?
        public var id: Int { tmdbId }
    }

    public var id: Int
    public var kind: String
    public var path: String
    public var folder: String
    public var parsedTitle: String?
    public var parsedYear: Int?
    public var reason: String?
    public var candidates: [Candidate]
}

public struct UnmatchedResponse: Codable, Hashable, Sendable {
    public var items: [UnmatchedItem]
}

public struct LeftOutItem: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var kind: String
    public var tmdbId: Int
    public var title: String
    public var year: Int?
    public var path: String?
    public var at: Int64
    public var who: String?
}

public struct LeftOutResponse: Codable, Hashable, Sendable {
    public var items: [LeftOutItem]
}

/// `GET /api/activity/count`: how many streams are playing.
public struct ActivityCount: Codable, Hashable, Sendable {
    public var playing: Int
}
