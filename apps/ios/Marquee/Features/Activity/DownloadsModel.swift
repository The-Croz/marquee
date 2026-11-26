import MarqueeKit
import Observation
import SwiftUI

enum DownloadsFilter: Hashable { case onTheWay, needsALook, sharing, history }

@Observable @MainActor
final class DownloadsModel {
    private(set) var view: DownloadsView?
    private(set) var loadProblem: MarqueeError?
    private(set) var loading = true
    private(set) var forbidden = false
    var filter: DownloadsFilter = .onTheWay
    /// What happened to copies lately (sent, imported, upgraded, failed), newest first. Loaded when History is picked.
    private(set) var history: [HistoryItem]?
    private(set) var historyProblem: String?
    var actionProblem: String?
    var toast: String?

    private let app: AppModel

    init(app: AppModel) {
        self.app = app
    }

    /// Removed downloads live in History, not here.
    var items: [DownloadView] { (view?.items ?? []).filter { $0.state != .removed } }
    var onTheWay: [DownloadView] { items.filter { $0.state == .sent || $0.state == .downloading }.sorted { $0.addedAt > $1.addedAt } }
    var sharing: [DownloadView] { items.filter { $0.state == .done } }
    var finishedToday: [DownloadView] { sharing.filter { Format.isToday($0.finishedAt ?? $0.addedAt) } }
    /// Things that went wrong and aren't downloading any more (finished but not in the library, failed).
    var needsALook: [DownloadView] { items.filter { $0.state == .failed } }

    func load() async {
        do {
            view = try await app.client.get("/api/downloads")
            await LiveActivityController.shared.sync(view?.items ?? [])
            loadProblem = nil
            forbidden = false
        } catch {
            if case .signedOut = error { app.handle(error); return }
            if case .cancelled = error { return }
            if error.isForbidden { forbidden = true } else { loadProblem = error }
        }
        loading = false
    }

    func loadHistory() async {
        do {
            let v: HistoryView = try await app.client.get("/api/history")
            history = v.items
            historyProblem = nil
        } catch {
            if case .signedOut = error { app.handle(error); return }
            if case .cancelled = error { return }
            historyProblem = error.fullText
        }
    }

    func act(_ d: DownloadView, _ path: String, body: some Encodable & Sendable = EmptyBody()) async {
        do {
            let result: DownloadActionResult = try await app.client.send("POST", "/api/downloads/\(d.id)/\(path)", body: body)
            toast = result.message
            actionProblem = nil
            await load()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            actionProblem = error.fullText
        }
    }

    struct RemoveBody: Encodable { var deleteFiles: Bool }

    func remove(_ d: DownloadView, deleteFiles: Bool) async {
        await act(d, "remove", body: RemoveBody(deleteFiles: deleteFiles))
    }
}
