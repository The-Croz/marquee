import Foundation

public struct HomeData: Codable, Hashable, Sendable {
    public struct Attention: Codable, Hashable, Sendable, Identifiable {
        public var key: String
        /// "problem" (something broke) or "attention" (someone is waiting on you).
        public var tone: String
        public var title: String
        /// What it means, or when it tries again by itself.
        public var detail: String?
        public var posterPath: String?
        public var to: String
        public var action: String
        /// A request that can be approved right here.
        public var approveId: Int?

        public var id: String { key }
        public var isProblem: Bool { tone == "problem" }
    }

    public struct Download: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var title: String
        public var href: String?
        public var posterPath: String?
        /// 0 to 100.
        public var percent: Double
        public var label: String
    }

    public struct Title: Codable, Hashable, Sendable, Identifiable {
        public var title: String
        /// "Movie · 4K" or "S2 E7 · 1080p".
        public var sub: String
        public var posterPath: String?
        public var posterColor: String?
        public var href: String
        public var addedAt: Int64

        public var id: String { href }
    }

    public struct Upcoming: Codable, Hashable, Sendable, Identifiable {
        public var day: String
        public var title: String
        public var note: String
        public var href: String?
        public var posterPath: String?
        public var backdropPath: String?

        public var id: String { "\(day)|\(title)|\(note)" }
    }

    public struct Stat: Codable, Hashable, Sendable, Identifiable {
        public var label: String
        public var value: String
        public var to: String?

        public var id: String { label }
    }

    public struct Hero: Codable, Hashable, Sendable {
        public struct Suggestion: Codable, Hashable, Sendable {
            public var kind: String
            public var tmdbId: Int
        }

        /// "ready", "arrived", "aired", "coming", "picked", "unwatched" or "random".
        public var kind: String
        /// "Ready to watch · you asked for it", "Recently added · today", "Coming Fri".
        public var eyebrow: String
        public var title: String
        public var chips: [String]
        public var href: String?
        /// A suggestion that may not be in the library: open it from TMDB when there's no href.
        public var discover: Suggestion?
        public var backdropPath: String?
        public var posterPath: String?
        public var color: String?
        /// Always nil from a current Marquee.
        public var progress: Double?
        public var note: String?
        public var year: Int?
        public var rating: String?
        public var runtime: Int?
        public var genres: [String]
        public var score: Double?
        public var votes: Int?
        public var overview: String?
        public var kindLabel: String?
    }

    public struct SetupStep: Codable, Hashable, Sendable, Identifiable {
        public var key: String
        public var title: String
        public var detail: String
        public var to: String
        public var done: Bool
        public var optional: Bool?

        public var id: String { key }
    }

    public var needsYou: [Attention]
    public var watching: [NowPlaying]
    public var onItsWay: [Download]
    public var myRequests: [RequestView]
    public var recentRequests: [RequestView]
    public var recent: [Title]
    public var upcoming: [Upcoming]
    public var stats: [Stat]
    /// The banner's slides, in order. Missing from a Marquee that predates the rotating banner.
    public var heroes: [Hero]?
    public var hero: Hero?
    public var setup: [SetupStep]?

    public var slides: [Hero] { heroes ?? hero.map { [$0] } ?? [] }
}

/// One line about a stream: "Video" · "4K HEVC → 720p H264".
public struct StreamFact: Codable, Hashable, Sendable {
    public var label: String
    public var value: String
}

/// Someone playing something right now (Plex or Jellyfin).
public struct NowPlaying: Codable, Hashable, Sendable, Identifiable {
    public var server: String
    public var sessionId: String
    public var platform: String
    public var resolution: String?
    public var startedAt: Int64
    public var user: String
    public var title: String
    public var subtitle: String?
    public var device: String
    public var state: String
    /// 0 to 1.
    public var progress: Double
    public var transcoding: Bool
    public var convertReason: String?
    public var href: String?
    public var posterPath: String?
    public var backdropPath: String?
    /// How it's being sent to the device, in plain lines.
    public var facts: [StreamFact]?
    public var durationMs: Double?
    /// The viewer's picture, when Marquee has one.
    public var userAvatar: String?

    public var id: String { "\(server)|\(sessionId)" }
}
