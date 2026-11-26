import Foundation

public enum Role: WireString {
    case admin, member, kid
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "admin": self = .admin
        case "member": self = .member
        case "kid": self = .kid
        default: self = .unknown(wire)
        }
    }

    public var wire: String {
        switch self {
        case .admin: "admin"
        case .member: "member"
        case .kid: "kid"
        case .unknown(let text): text
        }
    }
}

public struct SessionUser: Codable, Hashable, Sendable {
    public struct Linked: Codable, Hashable, Sendable {
        public var plex: Bool
        public var oidc: Bool
        public var password: Bool
        public var jellyfin: Bool
    }

    public var id: Int
    public var username: String
    public var displayName: String
    public var role: Role
    public var linked: Linked
}

/// What `GET /api/auth/status` says: which ways of signing in are on.
public struct AuthStatus: Codable, Hashable, Sendable {
    public struct Provider: Codable, Hashable, Sendable {
        public var enabled: Bool
        public var name: String?
    }

    public struct Providers: Codable, Hashable, Sendable {
        public var password: Bool
        public var oidc: Provider
        public var plex: Provider
        public var jellyfin: Provider
    }

    public var setupRequired: Bool
    public var providers: Providers
    public var user: SessionUser?
    public var version: String
}

public struct Health: Codable, Hashable, Sendable {
    public var ok: Bool
    public var version: String
}

public struct MeResponse: Codable, Hashable, Sendable {
    public var user: SessionUser
}

/// The answer to an app sign-in: the token is in the body, not a cookie.
public struct AppSignIn: Codable, Hashable, Sendable {
    public var token: String
    public var user: SessionUser
}

/// Which phone is signing in.
public struct AppDeviceInput: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var kind: String

    public init(id: String, name: String, kind: String = "ios") {
        self.id = id
        self.name = name
        self.kind = kind
    }
}

/// The server's `{ error, message }` for anything that went wrong.
public struct ApiError: Codable, Hashable, Sendable {
    public var error: String
    public var message: String
}

public struct PlexPinStart: Codable, Hashable, Sendable {
    public var flowId: String
    public var authUrl: String
}

public enum PlexPinCheck: Decodable, Hashable, Sendable {
    case pending
    case ok(user: SessionUser, token: String?)
    case denied(message: String)
    case expired

    private enum Keys: String, CodingKey { case status, user, token, message }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .status) {
        case "ok": self = .ok(user: try c.decode(SessionUser.self, forKey: .user), token: try c.decodeIfPresent(String.self, forKey: .token))
        case "denied": self = .denied(message: try c.decodeIfPresent(String.self, forKey: .message) ?? "Plex turned that sign-in down.")
        case "expired": self = .expired
        default: self = .pending
        }
    }
}

public struct DeviceView: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var kind: String
    public var lastSeenAt: Int64
    public var signedIn: Bool
    public var current: Bool

    public var lastSeen: Date { date(fromMilliseconds: lastSeenAt) }
}

public struct DevicesResponse: Codable, Hashable, Sendable {
    public var devices: [DeviceView]
}
