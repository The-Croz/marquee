/// The tabs along the bottom.
public enum MainTab: String, Sendable, Hashable, CaseIterable {
    case home, discover, library, requests, downloads

    /// What each kind of person gets (matches the server: download progress is admin only).
    public static func tabs(for role: Role) -> [MainTab] {
        switch role {
        case .admin: [.home, .discover, .library, .requests, .downloads]
        case .member: [.home, .discover, .library, .requests]
        case .kid, .unknown: [.home, .discover, .library]
        }
    }
}
