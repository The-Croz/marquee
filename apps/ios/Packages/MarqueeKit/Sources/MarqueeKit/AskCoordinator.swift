import Foundation
import Observation

/// Asking for something waits three seconds before it's sent, so it can be taken back
/// (the web app does the same). Leaving the screen sends it straight away.
@MainActor @Observable
public final class AskCoordinator {
    public struct Ask: Hashable, Sendable {
        public var kind: String
        public var tmdbId: Int
        public var seasons: [Int]?

        public init(kind: String, tmdbId: Int, seasons: [Int]? = nil) {
            self.kind = kind
            self.tmdbId = tmdbId
            self.seasons = seasons
        }

        public var cardId: String { "\(kind)-\(tmdbId)" }
    }

    /// Held for the take-back window.
    public private(set) var waiting: Ask?
    /// Being sent right now.
    public private(set) var sending: Ask?

    private let delay: Duration
    private let send: @MainActor (Ask) async -> Void
    private var timer: Task<Void, Never>?

    public init(delay: Duration = .seconds(3), send: @escaping @MainActor (Ask) async -> Void) {
        self.delay = delay
        self.send = send
    }

    public func isBusy(_ cardId: String) -> Bool { waiting?.cardId == cardId || sending?.cardId == cardId }

    /// Starts the take-back window. Asking for something already held or being sent does nothing.
    public func ask(_ ask: Ask) {
        if isBusy(ask.cardId) { return }
        // Something else was waiting: it goes now, they did ask for it.
        if waiting != nil { Task { await flush(); hold(ask) } } else { hold(ask) }
    }

    private func hold(_ ask: Ask) {
        waiting = ask
        timer?.cancel()
        timer = Task { [delay] in
            try? await Task.sleep(for: delay)
            if !Task.isCancelled { await fire() }
        }
    }

    /// Takes the held ask back: nothing is sent.
    public func undo() {
        timer?.cancel()
        timer = nil
        waiting = nil
    }

    /// Sends the held ask now.
    public func flush() async {
        timer?.cancel()
        timer = nil
        await fire()
    }

    private func fire() async {
        guard let ask = waiting else { return }
        waiting = nil
        sending = ask
        await send(ask)
        sending = nil
    }
}
