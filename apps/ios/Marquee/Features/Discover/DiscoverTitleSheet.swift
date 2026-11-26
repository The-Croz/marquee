import MarqueeKit
import SwiftUI

/// A title from TMDB: what it is, where to watch it, and the button to ask for it.
struct DiscoverTitleSheet: View {
    let card: DiscoverCard
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var title = Loader<DiscoverTitle>()
    @State private var choosingSeasons = false
    @State private var takenBack = false

    private var kindPath: String { card.isMovie ? "movie" : "series" }
    /// The card with everything on it, once the title's information has arrived (a request only knows its name and poster).
    private var shown: DiscoverCard { title.value?.card ?? card }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    BackdropHero(path: shown.backdropPath ?? shown.posterPath, kicker: card.isMovie ? "Movie" : "Show", title: card.title, detail: facts, height: 300)
                    VStack(alignment: .leading, spacing: 18) {
                        if let t = title.value {
                            askArea(t)
                            if let tagline = t.tagline, !tagline.isEmpty { Text(tagline).font(.subheadline.italic()).foregroundStyle(.soft) }
                            Text(shown.overview).font(.subheadline).foregroundStyle(.soft).fixedSize(horizontal: false, vertical: true)
                            if let key = t.trailerKey, let url = URL(string: "https://www.youtube.com/watch?v=\(key)") {
                                Button("Trailer", systemImage: "play.fill") { openURL(url) }.buttonStyle(QuietButtonStyle())
                            }
                            RatingsRow(ratings: t.ratings)
                            if !t.watchOn.isEmpty {
                                Text("Where to watch: " + t.watchOn.map(\.name).joined(separator: ", ")).font(.footnote).foregroundStyle(.muted)
                            }
                            if !t.cast.isEmpty { CastRow(cast: t.cast) }
                            if t.details.stage == "announced" || !t.details.released {
                                StateLine(text: releaseLine(t), tone: .needsYou)
                            }
                        } else if title.loading {
                            Skeleton(height: 50); Skeleton(height: 80)
                        } else if let problem = title.problem {
                            MessageView(title: problem.title, detail: problem.advice, actionTitle: "Try again") { Task { await load() } }
                        }
                        Text("Information from TMDB.").font(.caption2).foregroundStyle(.dim)
                    }
                    .padding(.horizontal, 16)
                }
                .padding(.bottom, 30)
            }
            .ignoresSafeArea(edges: .top)
            .background(.ink)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .toolbarBackground(.hidden, for: .navigationBar)
            .task { await load() }
            .sheet(isPresented: $choosingSeasons) {
                if let t = title.value { SeasonPickerSheet(card: card, seasons: t.seasons) }
            }
        }
        .presentationBackground(Color.ink)
        .onChange(of: app.asked[card.id]?.id) { _, _ in Task { await load() } }
        .problemAlert(Binding(get: { app.askProblem }, set: { app.askProblem = $0 }))
        .onDisappear { Task { await app.asker.flush() } }
    }

    private func load() async {
        await title.run(app) { () async throws(MarqueeError) -> DiscoverTitle in try await app.client.get("/api/discover/title/\(kindPath)/\(card.tmdbId)") }
    }

    private var facts: String {
        [card.year.map(String.init), title.value?.certification, title.value?.runtime.map { "\($0) min" }, shown.genres.prefix(2).joined(separator: ", ")].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func releaseLine(_ t: DiscoverTitle) -> String {
        if let home = t.details.homeRelease { return "Not out to stream yet · \(home.known ? "" : "around ")\(home.date)" }
        if let date = t.details.releaseDate { return "Not out yet · \(date)" }
        return "Not out yet"
    }

    // MARK: Asking

    @ViewBuilder private func askArea(_ t: DiscoverTitle) -> some View {
        let holding = app.asker.waiting?.cardId == card.id
        let sending = app.asker.sending?.cardId == card.id
        VStack(alignment: .leading, spacing: 10) {
            if let r = t.request ?? app.asked[card.id] {
                StateLine(text: r.stateText, tone: r.state == .ready ? .ready : .needsYou)
                if r.state == .pending {
                    Button("Take it back") { Task { await takeBack(r) } }.buttonStyle(QuietButtonStyle())
                }
            }
            if let id = shown.libraryId, shown.state == .inLibrary {
                Button("Open in your library") {
                    dismiss()
                    app.open(TitleRoute(kind: card.isMovie ? .movie : .show, id: id))
                }
                .buttonStyle(PrimaryButtonStyle())
            } else if t.canRequest && app.asked[card.id] == nil {
                if card.isMovie {
                    Button { holding ? app.asker.undo() : app.asker.ask(.init(kind: "movie", tmdbId: card.tmdbId)) } label: {
                        Text(holding ? "Undo" : sending ? "Asking…" : "Ask for it")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(sending)
                    .accessibilityIdentifier("ask")
                } else {
                    Button { holding ? app.asker.undo() : app.asker.ask(.init(kind: "series", tmdbId: card.tmdbId)) } label: {
                        Text(holding ? "Undo" : sending ? "Asking…" : "Ask for the whole show")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(sending)
                    .accessibilityIdentifier("ask")
                    if !t.seasons.isEmpty {
                        Button("Choose seasons…") { choosingSeasons = true }.buttonStyle(QuietButtonStyle()).disabled(holding || sending)
                    }
                }
                if holding { Text("Asking in 3 seconds. Press Undo to take it back.").font(.caption).foregroundStyle(.muted) }
            } else if let note = t.note {
                StateLine(text: note, tone: .neutral)
            }
            if app.user?.role == .admin, shown.state != .inLibrary { addMenu }
        }
    }

    private struct AddBody: Encodable, Sendable {
        var kind: String
        var tmdbId: Int
        var wanted: Bool
        var preset: String?
    }

    private struct Added: Decodable, Sendable {
        var id: Int
        var kind: String
    }

    /// Admins: put a title in the library without a request, looking for it or not.
    private var addMenu: some View {
        Menu {
            if card.isMovie {
                Button("Add and look for it") { Task { await add(wanted: true, preset: nil) } }
            } else {
                Section("Add and look for") {
                    Button("Every episode") { Task { await add(wanted: true, preset: "all") } }
                    Button("Only new episodes") { Task { await add(wanted: true, preset: "future") } }
                    Button("The latest season") { Task { await add(wanted: true, preset: "latest") } }
                    Button("The first season") { Task { await add(wanted: true, preset: "first") } }
                }
            }
            Button("Just add it, don't look for it") { Task { await add(wanted: false, preset: nil) } }
        } label: {
            Text("Add to your library…").font(.body.weight(.semibold)).foregroundStyle(.textPrimary)
                .frame(maxWidth: .infinity, minHeight: 50)
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.lineStrong, lineWidth: 1))
        }
        .accessibilityIdentifier("add-to-library")
    }

    private func add(wanted: Bool, preset: String?) async {
        do {
            let r: Added = try await app.client.send("POST", "/api/library/add", body: AddBody(kind: card.kind, tmdbId: card.tmdbId, wanted: wanted, preset: preset))
            dismiss()
            app.open(TitleRoute(kind: r.kind == "movie" ? .movie : .show, id: r.id))
        } catch {
            if case .signedOut = error { app.handle(error); return }
            app.askProblem = error.fullText
        }
    }

    private func takeBack(_ r: RequestView) async {
        do {
            struct Ok: Decodable, Sendable {}
            let _: Ok = try await app.client.send("DELETE", "/api/requests/\(r.id)", body: EmptyBody())
            await load()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            app.askProblem = error.fullText
        }
    }
}

/// Choose seasons: look at each season's episodes first, then ask for the ones you pick.
struct SeasonPickerSheet: View {
    let card: DiscoverCard
    let seasons: [SeasonState]
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<Int> = []
    @State private var previews: [Int: Loader<SeasonPreview>] = [:]
    @State private var open: Set<Int> = []

    var body: some View {
        NavigationStack {
            List {
                ForEach(seasons.filter { $0.season > 0 }) { s in
                    let here = s.state == .inLibrary || s.state == .pending || s.state == .approved || s.state == .downloading
                    DisclosureGroup(isExpanded: Binding(get: { open.contains(s.season) }, set: { on in
                        if on { open.insert(s.season); Task { await preview(s.season) } } else { open.remove(s.season) }
                    })) {
                        if let loader = previews[s.season], let p = loader.value {
                            ForEach(p.episodes) { e in
                                HStack(alignment: .top) {
                                    Text("\(e.episode)").font(.caption.weight(.semibold)).foregroundStyle(.dim).frame(width: 24, alignment: .leading)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(e.title ?? "Episode \(e.episode)").font(.footnote).foregroundStyle(.textPrimary)
                                        Text(e.aired ? (e.airDate ?? "") : "Not out yet" + (e.airDate.map { " · \($0)" } ?? "")).font(.caption2).foregroundStyle(.muted)
                                    }
                                }
                            }
                        } else {
                            ProgressView().tint(.amber)
                        }
                    } label: {
                        HStack {
                            Button { toggle(s.season) } label: {
                                Image(systemName: picked.contains(s.season) ? "checkmark.circle.fill" : (here ? "checkmark.circle" : "circle"))
                                    .font(.title3).foregroundStyle(here ? Color.readyTeal : (picked.contains(s.season) ? Color.amber : Color.dim))
                                    .frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .disabled(here)
                            .accessibilityLabel("Season \(s.season)\(here ? ", already here or asked for" : "")")
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Season \(s.season)").font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                                Text("\(s.episodeCount) episodes" + (here ? " · already here or asked for" : "")).font(.caption).foregroundStyle(.muted)
                            }
                        }
                    }
                    .tint(.soft)
                    .listRowBackground(Color.panel)
                }
            }
            .scrollContentBackground(.hidden)
            .background(.ink)
            .navigationTitle("Choose seasons")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ask") {
                        app.asker.ask(.init(kind: "series", tmdbId: card.tmdbId, seasons: picked.sorted()))
                        dismiss()
                    }
                    .disabled(picked.isEmpty)
                    .accessibilityIdentifier("ask-seasons")
                }
            }
        }
        .presentationBackground(Color.ink)
    }

    private func toggle(_ s: Int) {
        if picked.contains(s) { picked.remove(s) } else { picked.insert(s) }
    }

    private func preview(_ season: Int) async {
        if previews[season] == nil { previews[season] = Loader<SeasonPreview>() }
        guard let loader = previews[season], loader.value == nil else { return }
        await loader.run(app) { () async throws(MarqueeError) -> SeasonPreview in try await app.client.get("/api/discover/title/series/\(card.tmdbId)/season/\(season)") }
    }
}
