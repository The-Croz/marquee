import Foundation

/// A word the server sends that has a few known values. A value we don't know yet
/// decodes as `.unknown(text)` instead of failing, so a newer Marquee never breaks an older app.
public protocol WireString: Codable, Hashable, Sendable {
    init(wire: String)
    var wire: String { get }
}

extension WireString {
    public init(from decoder: any Decoder) throws {
        self.init(wire: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wire)
    }
}

/// Milliseconds since 1970, as the server sends times.
public func date(fromMilliseconds ms: Int64) -> Date {
    Date(timeIntervalSince1970: Double(ms) / 1000)
}
