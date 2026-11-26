import MarqueeKit
import SwiftUI

/// Everything this person asked for, and how each one is going.
struct MyRequestsScreen: View {
    @Environment(AppModel.self) private var app
    @State private var loader = Loader<[RequestView]>()
    @State private var problem: String?

    var body: some View {
        LoadedView(loader: loader, retry: { Task { await load() } }) { items in
            List {
                if items.isEmpty {
                    MessageView(title: "You haven't asked for anything yet.", detail: "Ask for a movie or show from Discover or Search.").listRowBackground(Color.clear)
                }
                ForEach(items) { r in
                    RequestRow(request: r, showsPerson: false)
                        .listRowBackground(Color.panel)
                        .swipeActions(edge: .trailing) {
                            if r.state == .pending {
                                Button(role: .destructive) { Task { await takeBack(r) } } label: { Label("Take back", systemImage: "arrow.uturn.backward") }
                            }
                        }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
        .background(.ink)
        .navigationTitle("My requests")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .problemAlert($problem)
    }

    private func load() async {
        await loader.run(app) { () async throws(MarqueeError) -> [RequestView] in
            let answer: RequestsResponse = try await app.client.get("/api/requests")
            return answer.items
        }
    }

    private func takeBack(_ r: RequestView) async {
        struct Ok: Decodable, Sendable {}
        do {
            let _: Ok = try await app.client.send("DELETE", "/api/requests/\(r.id)", body: EmptyBody())
            await load()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}
