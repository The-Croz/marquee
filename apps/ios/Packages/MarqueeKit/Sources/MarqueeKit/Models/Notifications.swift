import Foundation

/// What this iPhone gets: every message its person can have, and the ones switched on
/// (GET and PUT /api/me/devices/:id/push/events).
public struct DevicePushEvents: Codable, Hashable, Sendable {
    public struct Event: Codable, Hashable, Sendable, Identifiable {
        public var key: String
        /// The section it belongs to, as the web page names it.
        public var group: String
        public var label: String
        public var description: String
        public var id: String { key }

        public init(key: String, group: String, label: String, description: String) {
            self.key = key
            self.group = group
            self.label = label
            self.description = description
        }
    }

    public struct Section: Hashable, Sendable, Identifiable {
        public var name: String
        public var events: [Event]
        public var id: String { name }
    }

    public var events: [Event]
    public var on: [String]

    public init(events: [Event], on: [String]) {
        self.events = events
        self.on = on
    }

    /// The web page's order. A group this app doesn't know yet goes at the end, so a newer Marquee loses nothing.
    private static let order = ["Requests", "Downloads", "Problems", "Watching", "Marquee"]

    public var sections: [Section] {
        var names = Self.order
        for event in events where !names.contains(event.group) { names.append(event.group) }
        return names.compactMap { name in
            let list = events.filter { $0.group == name }
            return list.isEmpty ? nil : Section(name: name, events: list)
        }
    }

    public mutating func set(_ key: String, on isOn: Bool) {
        on.removeAll { $0 == key }
        if isOn { on.append(key) }
    }
}

/// Switches some messages on or off for this iPhone, leaving the rest as they are.
public struct PushEventsChange: Encodable, Hashable, Sendable {
    public var events: [String]
    public var on: Bool

    public init(events: [String], on: Bool) {
        self.events = events
        self.on = on
    }
}
