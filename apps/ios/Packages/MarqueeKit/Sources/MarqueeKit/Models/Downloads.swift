import Foundation

public enum DownloadState: WireString {
    case sent, downloading, done, failed, removed
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "sent": self = .sent
        case "downloading": self = .downloading
        case "done": self = .done
        case "failed": self = .failed
        case "removed": self = .removed
        default: self = .unknown(wire)
        }
    }

    public var wire: String {
        switch self {
        case .sent: "sent"
        case .downloading: "downloading"
        case .done: "done"
        case .failed: "failed"
        case .removed: "removed"
        case .unknown(let text): text
        }
    }
}

/// How a status should feel: the server's own colour word.
public enum StatusTone: WireString {
    case good, busy, warn, bad, done, quiet
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "good": self = .good
        case "busy": self = .busy
        case "warn": self = .warn
        case "bad": self = .bad
        case "done": self = .done
        case "quiet": self = .quiet
        default: self = .unknown(wire)
        }
    }

    public var wire: String {
        switch self {
        case .good: "good"
        case .busy: "busy"
        case .warn: "warn"
        case .bad: "bad"
        case .done: "done"
        case .quiet: "quiet"
        case .unknown(let text): text
        }
    }
}

public struct DownloadStatus: Codable, Hashable, Sendable {
    /// "Downloading · 4.2 MB/s · about 12 min left", "Stuck · nobody is sharing it".
    public var label: String
    /// What it means and what happens next.
    public var detail: String?
    public var tone: StatusTone
    public var nextTryAt: Int64?
}

public struct DownloadView: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var kind: String
    public var posterPath: String?
    public var posterColor: String?
    public var movieId: Int?
    public var seriesId: Int?
    public var season: Int?
    public var episodes: [Int]?
    /// The copy's own name.
    public var title: String
    public var infoHash: String
    public var sourceName: String?
    public var quality: String?
    public var score: Double?
    public var size: Double?
    public var addedAt: Int64
    public var state: DownloadState
    public var adopted: Bool
    public var progress: Double
    public var message: String?
    /// "Dune: Part Two (2024)" or "Severance · S02E03".
    public var titleName: String
    public var titleLink: String?
    public var status: DownloadStatus
    public var canControl: Bool
    public var canImport: Bool
    public var canRemoveShared: Bool
    public var canTryAnother: Bool
    public var unpacked: Bool
    public var importedPaths: [String]?
    public var speed: Double?
    public var uploadSpeed: Double?
    public var eta: Double?
    public var seeds: Int?
    public var peers: Int?
    public var ratio: Double?
    public var uploaded: Double?
    public var finishedAt: Int64?
    public var profileName: String?

    public var added: Date { date(fromMilliseconds: addedAt) }
    public var isPaused: Bool { status.label.hasPrefix("Paused") }
}

public struct DownloadsView: Codable, Hashable, Sendable {
    public struct Problem: Codable, Hashable, Sendable {
        public var label: String
        public var fix: String?
    }

    public var items: [DownloadView]
    /// qBittorrent couldn't be checked: what's wrong and what to do. nil when it answered.
    public var problem: Problem?
    public var checkedAt: Int64?
}

public struct DownloadsSummary: Codable, Hashable, Sendable {
    public var active: Int
}

public struct DownloadActionResult: Codable, Hashable, Sendable {
    public var message: String
    public var next: DownloadView?
}
