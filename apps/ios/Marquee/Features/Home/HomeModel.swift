import MarqueeKit
import Observation
import SwiftUI

/// What Home shows, kept fresh every few seconds.
@Observable @MainActor
final class HomeModel {
    private(set) var data: HomeData?
    private(set) var loadProblem: MarqueeError?
    private(set) var loading = true
    /// Requests being approved right now, so a button can't be pressed twice.
    private(set) var approving: Set<Int> = []
    var actionProblem: String?

    private let app: AppModel

    init(app: AppModel) {
        self.app = app
    }

    func load() async {
        do {
            data = try await app.client.get("/api/home")
            loadProblem = nil
        } catch {
            if case .signedOut = error { app.handle(error); return }
            if case .cancelled = error { return }
            loadProblem = error
        }
        loading = false
    }

    func approve(_ id: Int) async {
        guard !approving.contains(id) else { return }
        approving.insert(id)
        defer { approving.remove(id) }
        do {
            let _: RequestView = try await app.client.post("/api/requests/\(id)/approve")
            actionProblem = nil
            await load()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            actionProblem = error.fullText
        }
    }
}
