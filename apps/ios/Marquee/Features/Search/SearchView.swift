import MarqueeKit
import SwiftUI

@Observable @MainActor
final class SearchModel {
    var query = ""
    private(set) var inLibrary: [LibraryCard] = []
    private(set) var elsewhere: [SearchResult] = []
    private(set) var searching = false
    private(set) var problem: String?
    private(set) var searched = false

    func run(_ app: AppModel) async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else {
            inLibrary = []; elsewhere = []; searched = false; problem = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(350))
        if Task.isCancelled { return }
        searching = true
        defer { searching = false }
        let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        do {
            let m: LibraryList = try await app.client.get("/api/movies?q=\(enc)")
            let s: LibraryList = try await app.client.get("/api/shows?q=\(enc)")
            inLibrary = Array((m.items + s.items).prefix(15))
            // TMDB's results are a bonus: if they fail, what's in the library still shows.
            let tmdb: SearchResults? = try? await app.client.get("/api/library/search?q=\(enc)")
            elsewhere = (tmdb?.results ?? []).filter { $0.libraryId == nil }
            problem = nil
            searched = true
        } catch {
            if case .signedOut = error { app.handle(error); return }
            if case .cancelled = error { return }
            problem = error.fullText
        }
    }
}

/// Search: your library first, then everything else on TMDB, which you can ask for.
struct SearchView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model = SearchModel()
    @State private var opened: DiscoverCard?

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.searchPath) {
            List {
                if let problem = model.problem {
                    Text(problem).font(.subheadline).foregroundStyle(.warn).listRowBackground(Color.clear)
                }
                if model.searched && model.inLibrary.isEmpty && model.elsewhere.isEmpty && model.problem == nil {
                    MessageView(title: "Nothing found for “\(model.query)”.", detail: "Check the spelling, or try fewer words.").listRowBackground(Color.clear)
                }
                if !model.inLibrary.isEmpty {
                    Section {
                        ForEach(model.inLibrary) { item in
                            NavigationLink(value: TitleRoute(kind: item.isMovie ? .movie : .show, id: item.id)) {
                                row(poster: item.posterPath, color: item.posterColor, title: item.title, sub: "\(item.isMovie ? "Movie" : "Show") · \(item.year.map(String.init) ?? "") · \(item.badge)")
                            }
                            .listRowBackground(Color.panel)
                        }
                    } header: { header("In your library") }
                }
                if !model.elsewhere.isEmpty {
                    Section {
                        ForEach(model.elsewhere) { r in
                            Button { opened = card(r) } label: {
                                row(poster: r.posterPath, color: nil, title: r.title, sub: "\(r.kind == "movie" ? "Movie" : "Show") · \(r.year.map(String.init) ?? "")")
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(Color.panel)
                        }
                    } header: { header("Not in your library yet") }
                }
                if model.query.isEmpty {
                    MessageView(title: "Look for a movie or show.", detail: "Type a title above.").listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(.ink)
            .navigationTitle("Search")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Movies and shows")
            .navigationDestination(for: TitleRoute.self) { TitleView(route: $0) }
            .overlay { if model.searching && model.inLibrary.isEmpty && model.elsewhere.isEmpty { ProgressView().tint(.amber) } }
        }
        .task(id: model.query) { await model.run(app) }
        .sheet(item: $opened) { DiscoverTitleSheet(card: $0) }
    }

    private func header(_ text: String) -> some View {
        Text(text).font(.footnote.weight(.semibold)).foregroundStyle(.muted).textCase(nil)
    }

    private func row(poster: String?, color: String?, title: String, sub: String) -> some View {
        HStack(spacing: 12) {
            PosterView(path: poster, color: color, title: title, size: .w185).frame(width: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(2)
                Text(sub).font(.caption).foregroundStyle(.muted)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private func card(_ r: SearchResult) -> DiscoverCard {
        DiscoverCard(kind: r.kind, tmdbId: r.tmdbId, title: r.title, year: r.year, posterPath: r.posterPath, backdropPath: nil, overview: r.overview, score: nil, genres: [], state: .none, libraryId: nil, badge: nil)
    }
}
