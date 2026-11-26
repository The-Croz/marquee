import Foundation

public enum AddressError: Error, Equatable, Sendable {
    case empty
    case invalid
    case needsHTTPS

    public var message: String {
        switch self {
        case .empty: "Type your Marquee's address, like 192.168.1.20:9797."
        case .invalid: "That doesn't look like an address. Try something like 192.168.1.20:9797 or marquee.example.com."
        case .needsHTTPS: "Outside addresses must start with https://."
        }
    }
}

/// The two places Marquee can be reached: at home on your Wi-Fi, and from anywhere through Pangolin.
public struct ServerAddresses: Codable, Sendable, Equatable {
    public var home: URL
    public var outside: URL?

    public init(home: URL, outside: URL? = nil) {
        self.home = home
        self.outside = outside
    }
}

public enum ServerAddress {
    /// Turns what someone typed into an address: adds `http://` for an IP, `.local` or `localhost`,
    /// else `https://`; drops a trailing slash and any path.
    public static func normalize(_ text: String) throws(AddressError) -> URL {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { throw .empty }

        let hasScheme = trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://")
        let withScheme: String
        if hasScheme {
            withScheme = trimmed
        } else {
            let hostPart = trimmed.split(separator: "/", maxSplits: 1).first.map(String.init) ?? trimmed
            let host = hostPart.split(separator: ":", maxSplits: 1).first.map(String.init) ?? hostPart
            withScheme = (isLocal(host) ? "http://" : "https://") + trimmed
        }

        guard var parts = URLComponents(string: withScheme), let host = parts.host, !host.isEmpty, let scheme = parts.scheme?.lowercased() else {
            throw .invalid
        }
        if scheme == "http" && !isLocal(host) { throw .needsHTTPS }
        parts.scheme = scheme
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        parts.user = nil
        parts.password = nil
        guard let url = parts.url else { throw .invalid }
        return url
    }

    /// An address on your own network: an IP number, a `.local` name, `localhost` or a bare name.
    static func isLocal(_ host: String) -> Bool {
        let h = host.lowercased()
        if h == "localhost" || h.hasSuffix(".local") || h.hasSuffix(".localhost") { return true }
        if !h.contains(".") && !h.contains(":") { return true }
        let parts = h.split(separator: ".")
        return parts.count == 4 && parts.allSatisfy { UInt8($0) != nil } || h.contains(":") && h.hasPrefix("[")
    }

    /// "192.168.1.20:9797" for messages.
    public static func display(_ url: URL) -> String {
        guard let host = url.host else { return url.absoluteString }
        if let port = url.port { return "\(host):\(port)" }
        return host
    }
}

/// Remembers the addresses between launches.
public struct AddressStore: Sendable {
    private let key = "marquee.addresses"

    public init() {}

    public func load() -> ServerAddresses? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(ServerAddresses.self, from: data)
    }

    public func save(_ addresses: ServerAddresses?) {
        guard let addresses, let data = try? JSONEncoder().encode(addresses) else {
            UserDefaults.standard.removeObject(forKey: key)
            return
        }
        UserDefaults.standard.set(data, forKey: key)
    }
}
