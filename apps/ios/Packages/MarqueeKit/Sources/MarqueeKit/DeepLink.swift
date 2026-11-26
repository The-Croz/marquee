import Foundation

public enum TitleKind: String, Sendable, Hashable {
    case movie, show
}

/// A movie or show in the library, as a place to go.
public struct TitleRoute: Hashable, Sendable {
    public var kind: TitleKind
    public var id: Int

    public init(kind: TitleKind, id: Int) {
        self.kind = kind
        self.id = id
    }

    /// The server's own page paths, "/movies/12" and "/shows/3".
    public init?(webPath: String?) {
        guard let webPath else { return nil }
        let parts = webPath.split(separator: "/").map(String.init)
        guard parts.count == 2, let id = Int(parts[1]) else { return nil }
        switch parts[0] {
        case "movies": self.init(kind: .movie, id: id)
        case "shows": self.init(kind: .show, id: id)
        default: return nil
        }
    }
}

/// Where a `marquee://` link (a push notification's) goes.
public enum DeepLink: Equatable, Sendable {
    case title(TitleRoute)
    case requests
    case downloads

    public init?(url: URL) {
        guard url.scheme == "marquee", let host = url.host() else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch host {
        case "title":
            guard parts.count == 2, let id = Int(parts[1]), let kind = TitleKind(rawValue: parts[0]) else { return nil }
            self = .title(TitleRoute(kind: kind, id: id))
        case "requests": self = .requests
        case "downloads": self = .downloads
        default: return nil
        }
    }
}
