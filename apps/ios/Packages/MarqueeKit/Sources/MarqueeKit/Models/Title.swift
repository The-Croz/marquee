import Foundation

public struct MovieDetail: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var tmdbId: Int
    public var imdbId: String?
    public var title: String
    public var year: Int?
    public var overview: String?
    public var posterPath: String?
    public var posterColor: String?
    public var backdropPath: String?
    public var runtime: Int?
    public var certification: String?
    public var genres: [String]
    public var path: String?
    /// Wanted: Marquee looks for it by itself.
    public var monitored: Bool
    public var profile: String
    public var profileByHand: Bool
    public var addedAt: Int64
    public var files: [MediaFileView]
}

public struct EpisodeView: Codable, Hashable, Sendable, Identifiable {
    public var episode: Int
    public var title: String?
    public var airDate: String?
    public var aired: Bool
    public var wanted: Bool
    public var file: MediaFileView?

    public var id: Int { episode }
}

public struct SeasonView: Codable, Hashable, Sendable, Identifiable {
    public var season: Int
    public var have: Int
    public var aired: Int
    public var total: Int
    public var episodes: [EpisodeView]

    public var id: Int { season }
}

public struct ShowDetail: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var tmdbId: Int
    public var tvdbId: Int?
    public var title: String
    public var year: Int?
    public var overview: String?
    public var posterPath: String?
    public var posterColor: String?
    public var backdropPath: String?
    public var status: String?
    public var network: String?
    public var certification: String?
    public var genres: [String]
    public var path: String?
    public var monitored: Bool
    public var profile: String
    public var profileByHand: Bool
    public var addedAt: Int64
    public var sizeBytes: Double
    public var seasons: [SeasonView]
}

public struct EpisodeDetailView: Codable, Hashable, Sendable {
    public struct File: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var path: String
        public var sizeBytes: Double
        public var quality: QualityView
        public var addedAt: Int64
        public var name: String
        public var otherEpisodes: [Int]
        public var shared: Bool
    }

    public struct Torrent: Codable, Hashable, Sendable, Identifiable {
        public var hash: String
        public var name: String
        public var followed: Bool
        public var inDownloader: Bool
        public var wholeSeason: Bool

        public var id: String { hash }
    }

    public var seriesId: Int
    public var season: Int
    public var episode: Int
    public var title: String?
    public var airDate: String?
    public var overview: String?
    public var aired: Bool
    public var wanted: Bool
    public var files: [File]
    public var torrents: [Torrent]
    public var downloaderNote: String?
}

// MARK: Copies we found

public struct CopyRule: Codable, Hashable, Sendable {
    public var trashId: String
    public var name: String
    public var label: String
    public var explain: String
    public var points: Int
}

public struct CopyRejection: Codable, Hashable, Sendable {
    public var code: String
    public var message: String
}

public struct CopyView: Codable, Hashable, Sendable, Identifiable {
    public struct VsYours: Codable, Hashable, Sendable {
        public var better: Bool
        public var message: String
    }

    public struct SourceRef: Codable, Hashable, Sendable {
        public var id: Int
        public var name: String
    }

    public var id: String?
    public var vsYours: VsYours?
    public var title: String
    public var sizeBytes: Double?
    public var seeders: Int?
    public var leechers: Int?
    public var sources: [SourceRef]
    public var quality: String
    public var qualityLabel: String
    public var tier: String?
    public var score: Double
    public var rules: [CopyRule]
    public var rejections: [CopyRejection]
    public var accepted: Bool
}

public struct CopiesResult: Codable, Hashable, Sendable {
    public struct Yours: Codable, Hashable, Sendable {
        public var name: String
        public var qualityLabel: String
        public var score: Double
    }

    public struct Profile: Codable, Hashable, Sendable {
        public var id: Int
        public var key: String
        public var name: String
    }

    public var searchId: String
    public var yours: Yours?
    public var profile: Profile
    public var copies: [CopyView]
}

public struct SendResult: Codable, Hashable, Sendable {
    public var download: DownloadView
    public var message: String
}

// MARK: History and problems

public struct HistoryItem: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var at: Int64
    public var event: String
    public var label: String
    public var tone: String
    public var titleName: String
    /// Its page, or nil when it's no longer in the library.
    public var titleLink: String?
    public var copy: String?
    public var source: String?
    public var quality: String?
    public var detail: String?
    public var who: String?
}

public struct HistoryView: Codable, Hashable, Sendable {
    public var items: [HistoryItem]
    /// Pass as `before` for the next (older) page; nil when there's no more.
    public var next: String?
}

public struct IssueView: Codable, Hashable, Sendable, Identifiable {
    public struct Comment: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var by: String
        public var body: String
        public var createdAt: Int64
    }

    public var id: Int
    public var kind: String
    public var titleId: Int?
    public var title: String
    public var `where`: String?
    public var problem: String
    public var problemText: String
    public var message: String
    public var status: String
    public var by: String
    public var createdAt: Int64
    public var comments: [Comment]

    public var isOpen: Bool { status == "open" }
}

public struct IssuesView: Codable, Hashable, Sendable {
    public var items: [IssueView]
}
