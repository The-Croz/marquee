import Foundation
import Testing
@testable import MarqueeKit

@MainActor
private final class Sent {
    var asks: [AskCoordinator.Ask] = []
}

@MainActor
@Suite struct AskCoordinatorTests {
    private let dune = AskCoordinator.Ask(kind: "movie", tmdbId: 1)
    private let bluey = AskCoordinator.Ask(kind: "series", tmdbId: 2, seasons: [3])

    private func make(_ sent: Sent) -> AskCoordinator {
        AskCoordinator(delay: .milliseconds(40)) { sent.asks.append($0) }
    }

    @Test func sendsOnceAfterTheWindow() async throws {
        let sent = Sent()
        let c = make(sent)
        c.ask(dune)
        #expect(c.waiting == dune)
        try await Task.sleep(for: .milliseconds(150))
        #expect(sent.asks == [dune])
        #expect(c.waiting == nil)
    }

    @Test func undoSendsNothing() async throws {
        let sent = Sent()
        let c = make(sent)
        c.ask(dune)
        c.undo()
        try await Task.sleep(for: .milliseconds(150))
        #expect(sent.asks.isEmpty)
    }

    @Test func pressingTwiceDoesNotAskTwice() async throws {
        let sent = Sent()
        let c = make(sent)
        c.ask(dune)
        c.ask(dune)
        try await Task.sleep(for: .milliseconds(150))
        c.ask(dune)
        try await Task.sleep(for: .milliseconds(150))
        // The third press came after it was sent, so that one is a new ask; the first two made one.
        #expect(sent.asks == [dune, dune])
    }

    @Test func askingForAnotherSendsTheFirstAtOnce() async throws {
        let sent = Sent()
        let c = make(sent)
        c.ask(dune)
        c.ask(bluey)
        try await Task.sleep(for: .milliseconds(20))
        #expect(sent.asks == [dune])
        #expect(c.waiting == bluey)
        try await Task.sleep(for: .milliseconds(150))
        #expect(sent.asks == [dune, bluey])
    }

    @Test func leavingTheScreenSendsAtOnce() async throws {
        let sent = Sent()
        let c = make(sent)
        c.ask(dune)
        await c.flush()
        #expect(sent.asks == [dune])
        try await Task.sleep(for: .milliseconds(150))
        #expect(sent.asks == [dune])
    }
}
