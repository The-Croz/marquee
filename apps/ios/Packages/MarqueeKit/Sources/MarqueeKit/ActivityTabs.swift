import Foundation

public enum ActivitySection: String, Sendable, Hashable, CaseIterable {
    case downloads, requests, watching

    public var title: String {
        switch self {
        case .downloads: "Downloads"
        case .requests: "Requests"
        case .watching: "Watching"
        }
    }
}

/// What each kind of person can see under Activity (matches the server: download progress is admin only).
public enum ActivityTabs {
    public static func sections(for role: Role) -> [ActivitySection] {
        switch role {
        case .admin: [.downloads, .requests, .watching]
        case .member: [.requests]
        case .kid, .unknown: []
        }
    }
}
