import Foundation

/// Small, tested pieces of push: the token as text, the bodies the server wants, what a tapped notification means,
/// and which pictures the notification extension may fetch.
public enum PushSupport {
    /// The device token as the lowercase hex text the server stores.
    public static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    public struct Registration: Codable, Equatable, Sendable {
        public var token: String
        public var environment: String

        /// Debug builds talk to Apple's sandbox, release builds to the real service.
        public init(token: String, debug: Bool) {
            self.token = token
            environment = debug ? "sandbox" : "production"
        }
    }

    /// What was pressed on a notification, and on which request.
    public enum Action: Equatable, Sendable {
        case approve(requestId: Int)
        case turnDown(requestId: Int)
        case open(DeepLink)
        case nothing
    }

    public static let approveID = "approve"
    public static let turnDownID = "turndown"
    public static let requestCategory = "request_waiting"

    /// `actionID` is the pressed button (or the default tap), `userInfo` the push's own keys.
    public static func action(actionID: String, userInfo: [AnyHashable: Any]) -> Action {
        let requestId = (userInfo["requestId"] as? Int) ?? (userInfo["requestId"] as? NSNumber)?.intValue
        switch actionID {
        case approveID:
            if let requestId { return .approve(requestId: requestId) }
            return .nothing
        case turnDownID:
            if let requestId { return .turnDown(requestId: requestId) }
            return .nothing
        default:
            if let link = DeepLink(serverLink: userInfo["link"] as? String) { return .open(link) }
            return .nothing
        }
    }

    /// Cover art on a push: only TMDB's pictures, over https.
    public static func isAllowedCoverArt(_ text: String?) -> Bool {
        guard let text, let url = URL(string: text), url.scheme == "https", url.host() == "image.tmdb.org" else { return false }
        return true
    }

    /// A picture bigger than this is left off the notification.
    public static let maxCoverArtBytes = 2_500_000
}

extension DeepLink {
    /// The link a push carries: a `marquee://` link, or the server's own address of a page ("https://host/requests").
    public init?(serverLink: String?) {
        guard let serverLink, let url = URL(string: serverLink) else { return nil }
        if url.scheme == "marquee", let link = DeepLink(url: url) {
            self = link
            return
        }
        guard url.scheme == "http" || url.scheme == "https" else { return nil }
        switch url.path {
        case "/requests": self = .requests
        case "/downloads": self = .downloads
        default:
            guard let route = TitleRoute(webPath: url.path) else { return nil }
            self = .title(route)
        }
    }
}
