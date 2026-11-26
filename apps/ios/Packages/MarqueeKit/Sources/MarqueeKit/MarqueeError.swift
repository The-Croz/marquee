import Foundation

/// Everything that can go wrong talking to Marquee, in words that say what happened
/// and what to do about it.
public enum MarqueeError: Error, Equatable, Sendable {
    /// Marquee answered with its own message (shown as it is).
    case server(code: String, message: String)
    case signedOut
    case pangolinInTheWay
    case unreachable(URL)
    case tooOld
    case decoding(String)

    public var title: String {
        switch self {
        case .server(_, let message): message
        case .signedOut: "You were signed out."
        case .pangolinInTheWay: "Pangolin's sign-in is in the way."
        case .unreachable(let url): "Can't reach Marquee at \(ServerAddress.display(url))."
        case .tooOld: "This Marquee is too old for the app."
        case .decoding: "Marquee sent something the app didn't expect."
        }
    }

    public var advice: String {
        switch self {
        case .server: ""
        case .signedOut: "Sign in again."
        case .pangolinInTheWay: "In Pangolin, add a rule to the Marquee resource that skips sign-in for /api/*."
        case .unreachable: "Check you're on your home Wi-Fi, or add your outside address under Server."
        case .tooOld: "Update Marquee to the newest version, then sign in again."
        case .decoding: "Update the app and Marquee to their newest versions."
        }
    }

    /// Title and advice together, for a line of text.
    public var fullText: String { advice.isEmpty ? title : "\(title) \(advice)" }

    /// The server said no (403): the person isn't allowed.
    public var isForbidden: Bool {
        if case .server(let code, _) = self { return code == "forbidden" }
        return false
    }

    public var code: String? {
        if case .server(let code, _) = self { return code }
        return nil
    }
}
