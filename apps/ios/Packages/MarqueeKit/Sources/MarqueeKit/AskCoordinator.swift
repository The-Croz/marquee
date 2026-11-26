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
    /// Asks that are decided and waiting their turn to be sent, in order.
    private var outbox: [Ask] = []
    private var draining = false

    public init(delay: Duration = .seconds(3), send: @escaping @MainActor (Ask) async -> Void) {
        self.delay = delay
        self.send = send
    }

    public func isBusy(_ cardId: String) -> Bool {
        waiting?.cardId == cardId || sending?.cardId == cardId || outbox.contains { $0.cardId == cardId }
    }

    /// Starts the take-back window. Asking for something already held or being sent does nothing.
    /// Something else that was waiting goes now (they did ask for it), and nothing is ever dropped.
    public func ask(_ ask: Ask) {
        if isBusy(ask.cardId) { return }
        release()
        waiting = ask
        timer = Task { [delay] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            // Forget this task first: flush cancels the timer, and a cancelled task can't send anything.
            timer = nil
            await flush()
        }
    }

    /// Takes the held ask back: nothing is sent.
    public func undo() {
        timer?.cancel()
        timer = nil
        waiting = nil
    }

    /// Sends the held ask now (and anything still queued), and returns when they are all sent.
    public func flush() async {
        release()
        await drain()
    }

    /// Moves the held ask to the outbox and starts sending.
    private func release() {
        timer?.cancel()
        timer = nil
        if let held = waiting {
            waiting = nil
            outbox.append(held)
            Task { await drain() }
        }
    }

    private func drain() async {
        guard !draining else { return }
        draining = true
        while !outbox.isEmpty {
            let next = outbox.removeFirst()
            sending = next
            await send(next)
            sending = nil
        }
        draining = false
    }
}
