import MarqueeKit
import SwiftUI

struct DiscoverView: View {
    @Environment(AppModel.self) private var app
    @State private var model = DiscoverModel()
    @State private var opened: DiscoverCard?

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.discoverPath) {
            LoadedView(loader: model.page, forbiddenText: "Discover isn't available for this account.", retry: { Task { await model.load(app) } }) { page in
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if !page.hero.isEmpty { featured(page.hero) }
                        filters(page)
                        ForEach(page.rows) { row in rowView(row) }
                        if page.rows.isEmpty {
                            MessageView(title: "Nothing to show here.", detail: "Try another service or kind of title.")
                        }
                        Text("Movie and show information from TMDB. Where to watch comes from JustWatch through TMDB.")
                            .font(.caption2).foregroundStyle(.dim).padding(.horizontal, 20).padding(.bottom, 24)
                    }
                }
                .refreshable { await model.load(app) }
            }
            .background(.ink)
            .navigationTitle("Discover")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    AvatarButton(initial: app.user?.displayName ?? "?") { app.showingYou = true }.accessibilityIdentifier("avatar")
                }
            }
            .navigationDestination(for: TitleRoute.self) { TitleView(route: $0) }
        }
        .task(id: "\(model.type)|\(model.service)|\(model.genre ?? "")") { await model.load(app) }
        .sheet(item: $opened) { card in DiscoverTitleSheet(card: card) }
    }

    private func open(_ card: DiscoverCard) {
        if card.state == .inLibrary, let id = card.libraryId {
            app.discoverPath.append(TitleRoute(kind: card.isMovie ? .movie : .show, id: id))
        } else {
            opened = card
        }
    }

    // MARK: Pieces

    private func featured(_ cards: [DiscoverCard]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 12) {
                ForEach(cards.prefix(8)) { card in
                    Button { open(card) } label: {
                        ZStack(alignment: .bottomLeading) {
                            Placeholder.fill(title: card.title, color: nil)
                            if let url = TMDBImage.url(path: card.backdropPath ?? card.posterPath, size: .w1280) {
                                AsyncImage(url: url) { phase in if let image = phase.image { image.resizable().scaledToFill() } }
                            }
                            LinearGradient(colors: [.clear, .black.opacity(0.82)], startPoint: .init(x: 0.5, y: 0.3), endPoint: .bottom)
                            VStack(alignment: .leading, spacing: 4) {
                                Text((card.badge ?? (card.isMovie ? "Movie" : "Show")).uppercased()).font(.caption2.weight(.bold)).tracking(1.2).foregroundStyle(.amberHi)
                                Text(card.title).font(.titleSerif(34)).foregroundStyle(.white).lineLimit(2).minimumScaleFactor(0.7)
                                Text(stateLine(card)).font(.caption).foregroundStyle(.white.opacity(0.85))
                            }
                            .padding(16)
                        }
                        .frame(width: 330, height: 210)
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(card.title), \(stateLine(card))")
                    .accessibilityIdentifier("featured-\(card.tmdbId)")
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func stateLine(_ card: DiscoverCard) -> String {
        switch card.state {
        case .inLibrary: "In your library"
        case .downloading: "Downloading"
        case .pending: "Asked for · waiting for an admin"
        case .approved: "Asked for · approved"
        case .declined: "Turned down"
        default: ([card.year.map(String.init)] + card.genres.prefix(2).map { Optional($0) }).compactMap { $0 }.joined(separator: " · ")
        }
    }

    @ViewBuilder
    private func filters(_ page: DiscoverPage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Kind", selection: $model.type) {
                Text("All").tag("all")
                Text("Movies").tag("movie")
                Text("Shows").tag("series")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Chip(title: "Everything", selected: model.service == "all") { model.service = "all" }
                    ForEach(page.services) { s in Chip(title: s.name, selected: model.service == s.key) { model.service = s.key } }
                    if !page.genres.isEmpty {
                        Menu {
                            Button("Any genre") { model.genre = nil }
                            ForEach(page.genres, id: \.self) { g in Button(g) { model.genre = g } }
                        } label: {
                            Text(model.genre ?? "Genre ▾").font(.footnote.weight(.semibold)).foregroundStyle(model.genre == nil ? Color.soft : Color.amberHi)
                                .padding(.horizontal, 14).frame(minHeight: 44)
                                .overlay(Capsule().stroke(model.genre == nil ? Color.lineStrong : Color.amber, lineWidth: 1))
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }

    private func rowView(_ row: DiscoverRow) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                SectionTitle(text: row.title)
                if let sub = row.subtitle { Text(sub).font(.caption).foregroundStyle(.muted) }
            }
            .padding(.horizontal, 16)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 10) {
                    ForEach(row.items) { card in
                        Button { open(card) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                PosterView(path: card.posterPath, color: nil, title: card.title)
                                    .frame(width: 118)
                                    .overlay(alignment: .topTrailing) { stateBadge(card) }
                                Text(card.title).font(.caption.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(1).frame(width: 118, alignment: .leading)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(card.title), \(stateLine(card))")
                        .accessibilityIdentifier("card-\(card.tmdbId)")
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }

    @ViewBuilder
    private func stateBadge(_ card: DiscoverCard) -> some View {
        switch card.state {
        case .inLibrary: badge("checkmark", .readyTeal)
        case .pending, .approved, .downloading: badge("clock", .amber)
        default: EmptyView()
        }
    }

    private func badge(_ icon: String, _ color: Color) -> some View {
        Image(systemName: icon).font(.system(size: 11, weight: .bold)).foregroundStyle(.ink)
            .frame(width: 22, height: 22).background(color, in: Circle()).padding(5)
            .accessibilityHidden(true)
    }
}
