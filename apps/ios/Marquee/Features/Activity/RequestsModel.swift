import MarqueeKit
import Observation
import SwiftUI

@Observable @MainActor
final class RequestsModel {
    private(set) var items: [RequestView] = []
    private(set) var loadProblem: MarqueeError?
    private(set) var loading = true
    private(set) var forbidden = false
    private(set) var busy: Set<Int> = []
    var actionProblem: String?
    /// The words in the toast, and what Undo does.
    var toast: String?
    private var undoRequest: Int?

    private let app: AppModel
    var isAdmin: Bool { app.user?.role == .admin }

    init(app: AppModel) {
        self.app = app
    }

    var waiting: [RequestView] { items.filter { $0.state == .pending } }
    var recent: [RequestView] { items.filter { $0.state != .pending } }

    func load() async {
        do {
            let scope = isAdmin ? "all" : "mine"
            let answer: RequestsResponse = try await app.client.get("/api/requests?scope=\(scope)")
            items = answer.items
            loadProblem = nil
            forbidden = false
        } catch {
            if case .signedOut = error { app.handle(error); return }
            if case .cancelled = error { return }
            if error.isForbidden { forbidden = true } else { loadProblem = error }
        }
        loading = false
    }

    func approve(_ r: RequestView, announce: Bool = true) async {
        guard !busy.contains(r.id) else { return }
        busy.insert(r.id)
        defer { busy.remove(r.id) }
        do {
            let _: RequestView = try await app.client.post("/api/requests/\(r.id)/approve")
            if announce { say("Approved \(r.title).", undoing: r.id) }
            await load()
        } catch {
            fail(error)
        }
    }

    func approveAll() async {
        let all = waiting
        var approved = 0
        for r in all {
            await approve(r, announce: false)
            if actionProblem == nil { approved += 1 } else { break }
        }
        if approved == all.count {
            say("Approved \(approved) \(approved == 1 ? "request" : "requests").", undoing: nil)
        } else if approved > 0 {
            say("Approved \(approved) of \(all.count). Try the rest again.", undoing: nil)
        }
    }

    struct Reason: Encodable { var reason: String }

    func turnDown(_ r: RequestView, reason: String) async {
        guard !busy.contains(r.id) else { return }
        busy.insert(r.id)
        defer { busy.remove(r.id) }
        do {
            let _: RequestView = try await app.client.send("POST", "/api/requests/\(r.id)/decline", body: Reason(reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)))
            say("Turned down \(r.title).", undoing: r.id)
            await load()
        } catch {
            fail(error)
        }
    }

    /// Takes the last approve or turn down back.
    func undo() async {
        guard let id = undoRequest else { return }
        undoRequest = nil
        do {
            let _: RequestView = try await app.client.post("/api/requests/\(id)/reopen")
            await load()
        } catch {
            fail(error)
        }
    }

    func takeBack(_ r: RequestView) async {
        do {
            let _: Empty = try await app.client.send("DELETE", "/api/requests/\(r.id)", body: EmptyBody())
            await load()
        } catch {
            fail(error)
        }
    }

    private struct Empty: Decodable, Sendable {}

    private func say(_ text: String, undoing id: Int?) {
        undoRequest = id
        toast = text
    }

    var canUndo: Bool { undoRequest != nil }

    private func fail(_ error: MarqueeError) {
        if case .signedOut = error { app.handle(error); return }
        actionProblem = error.fullText
    }
}
