import MarqueeKit
import SwiftUI

enum LibraryKind: String, CaseIterable, Identifiable {
    case movies, shows
    var id: String { rawValue }
    var title: String { self == .movies ? "Movies" : "Shows" }
}

enum LibraryFilter: String, CaseIterable, Identifiable {
    case all, have, missing, wantedMissing = "wanted_missing"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "Everything"
        case .have: "Have it"
        case .missing: "Missing"
        case .wantedMissing: "Wanted, nothing yet"
        }
    }
}

enum LibrarySort: String, CaseIterable, Identifiable {
    case added, title, year
    var id: String { rawValue }
    var title: String {
        switch self {
        case .added: "Recently added"
        case .title: "Title"
        case .year: "Year"
        }
    }
}

@Observable @MainActor
final class LibraryModel {
    let list = Loader<[LibraryCard]>()
    var kind: LibraryKind = .movies
    var filter: LibraryFilter = .all
    var sort: LibrarySort = .added
    var query = ""

    func load(_ app: AppModel) async {
        let path = "/api/\(kind.rawValue)?filter=\(filter.rawValue)&sort=\(sort.rawValue)" + (query.isEmpty ? "" : "&q=" + (query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""))
        await list.run(app) { () async throws(MarqueeError) -> [LibraryCard] in
            let answer: LibraryList = try await app.client.get(path)
            return answer.items
        }
    }

    var totalSize: String {
        let bytes = (list.value ?? []).reduce(0) { $0 + $1.sizeBytes }
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

struct LibraryView: View {
    @Environment(AppModel.self) private var app
    @State private var model = LibraryModel()

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.libraryPath) {
            VStack(spacing: 0) {
                Picker("Kind", selection: $model.kind) {
                    ForEach(LibraryKind.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(LibraryFilter.allCases) { f in
                            Chip(title: f.title, selected: model.filter == f) { model.filter = f }
                        }
                    }
                    .padding(.horizontal, 16)
                }

                LoadedView(loader: model.list, retry: { Task { await model.load(app) } }) { items in
                    grid(items)
                }
            }
            .background(.ink)
            .navigationTitle("Library")
            .searchable(text: $model.query, prompt: "Search your library")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Sort", selection: $model.sort) {
                            ForEach(LibrarySort.allCases) { Text($0.title).tag($0) }
                        }
                    } label: {
                        Image(systemName: "arrow.up.arrow.down").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Sort")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    AvatarButton { app.showingYou = true }.accessibilityIdentifier("avatar")
                }
            }
            .navigationDestination(for: TitleRoute.self) { TitleView(route: $0) }
            .onAppear { Task { await model.load(app) } }
        }
        .task(id: "\(model.kind.rawValue)|\(model.filter.rawValue)|\(model.sort.rawValue)|\(model.query)") {
            if !model.query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            if Task.isCancelled { return }
            await model.load(app)
        }
    }

    private func grid(_ items: [LibraryCard]) -> some View {
        ScrollView {
            if items.isEmpty {
                MessageView(title: model.query.isEmpty ? "Nothing here yet." : "Nothing matches that.", detail: model.filter == .all && model.query.isEmpty ? "Run a scan from Settings → Library on the web, and your movies and shows show up here." : "Try a different filter.")
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 3), spacing: 14) {
                    ForEach(items) { item in
                        NavigationLink(value: TitleRoute(kind: item.isMovie ? .movie : .show, id: item.id)) {
                            VStack(alignment: .leading, spacing: 5) {
                                PosterView(path: item.posterPath, color: item.posterColor, title: item.title)
                                    .overlay(alignment: .topLeading) { badge(item) }
                                Text(item.title).font(.caption.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(1)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(item.title), \(item.badge)")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                Text("\(items.count) \(model.kind == .movies ? (items.count == 1 ? "movie" : "movies") : (items.count == 1 ? "show" : "shows")) · \(model.totalSize)")
                    .font(.caption).foregroundStyle(.dim).padding(.vertical, 16)
            }
        }
        .refreshable { await model.load(app) }
    }

    private func badge(_ item: LibraryCard) -> some View {
        Text(item.badge)
            .font(.caption2.weight(.bold))
            .foregroundStyle(item.complete ? Color.amberInk : Color.white)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(item.complete ? Color.amber : Color.black.opacity(0.65), in: Capsule())
            .padding(6)
    }
}
