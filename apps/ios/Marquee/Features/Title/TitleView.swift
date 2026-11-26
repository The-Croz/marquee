import MarqueeKit
import SwiftUI

struct TitleView: View {
    let route: TitleRoute
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var model: TitleModel
    @State private var showCopies = false
    @State private var showIssue = false
    @State private var episode: EpisodeTarget?

    init(route: TitleRoute) {
        self.route = route
        _model = State(initialValue: TitleModel(route: route))
    }

    struct EpisodeTarget: Identifiable {
        var season: Int
        var episode: EpisodeView
        var id: String { "\(season)-\(episode.episode)" }
    }

    private var isAdmin: Bool { app.user?.role == .admin }

    var body: some View {
        Group {
            if let info = model.info {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        BackdropHero(path: info.backdropPath, kicker: kicker, title: info.title, detail: facts(info), height: 380)
                        VStack(alignment: .leading, spacing: 20) {
                            watchButtons
                            followButton
                            progressStrip(info)
                            if let tagline = model.about?.tagline, !tagline.isEmpty {
                                Text(tagline).font(.subheadline.italic()).foregroundStyle(.soft)
                            }
                            if let overview = info.overview, !overview.isEmpty {
                                Text(overview).font(.subheadline).foregroundStyle(.soft).fixedSize(horizontal: false, vertical: true)
                            }
                            aboutLine
                            fileLine
                            if isAdmin { adminControls(info) }
                            if model.route.kind == .show, let show = model.show.value { seasons(show) }
                            if let cast = model.about?.cast, !cast.isEmpty { CastRow(cast: cast) }
                            if isAdmin && !model.history.isEmpty { historySection }
                            problemsSection
                        }
                        .padding(.horizontal, 16)
                    }
                    .padding(.bottom, 40)
                }
                .ignoresSafeArea(edges: .top)
                .refreshable { await model.load(app) }
                .topFade(after: 120)
            } else {
                if model.forbidden {
                    MessageView(title: "That's not available.", detail: "").frame(maxHeight: .infinity, alignment: .top)
                } else if let problem = model.activeProblem {
                    MessageView(title: problem.title, detail: problem.advice, actionTitle: "Try again") { Task { await model.load(app) } }.padding(.top, 120)
                } else {
                    VStack(spacing: 10) { Skeleton(height: 300, radius: 0); Skeleton(height: 60); Skeleton(height: 60) }.padding(.top, 0)
                }
            }
        }
        .background(.ink)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
        }
        .refreshing(every: 10) { await model.load(app) }
        .sheet(isPresented: $showCopies) { CopiesSheet(model: model) }
        .sheet(isPresented: $showIssue) { IssueSheet(model: model) }
        .sheet(item: $episode) { target in EpisodeSheet(model: model, season: target.season, episode: target.episode) }
        .problemAlert(Binding(get: { model.problem }, set: { model.problem = $0 }))
    }

    // MARK: Hero text

    private var kicker: String {
        if let m = model.movie.value {
            if let best = m.files.first { return "In your library · \(best.quality.label)" }
            return m.monitored ? "Wanted · Marquee is looking" : "Not wanted"
        }
        if let s = model.show.value {
            let regular = s.seasons.filter { $0.season != 0 }
            let have = regular.reduce(0) { $0 + $1.have }
            let total = regular.reduce(0) { $0 + $1.aired }
            return have > 0 ? "In your library · \(have) of \(total) episodes" : (s.monitored ? "Wanted · Marquee is looking" : "Not wanted")
        }
        return ""
    }

    private func facts(_ info: TitleInfo) -> String {
        [info.year.map(String.init), info.certification, info.line.isEmpty ? nil : info.line, info.genres.prefix(2).joined(separator: ", ")]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Pieces

    /// Scores, who made it, and the trailer, like the web's title page.
    @ViewBuilder private var aboutLine: some View {
        if let about = model.about {
            let ratings = RatingsRow(ratings: about.ratings)
            if !ratings.isEmpty { ratings }
            let made = about.details.directors.isEmpty ? about.details.networks : about.details.directors
            if !made.isEmpty {
                Text("\(model.route.kind == .movie ? "Directed by" : (about.details.directors.isEmpty ? "On" : "Created by")) \(made.prefix(3).joined(separator: ", "))")
                    .font(.footnote).foregroundStyle(.muted)
            }
            if let key = about.trailerKey, let url = URL(string: "https://www.youtube.com/watch?v=\(key)") {
                Button("Trailer", systemImage: "play.fill") { openURL(url) }.buttonStyle(QuietButtonStyle())
            }
        }
    }

    @ViewBuilder private var watchButtons: some View {
        if !model.links.isEmpty {
            HStack(spacing: 10) {
                ForEach(model.links) { link in
                    Button("Watch in \(link.server)") {
                        if let url = URL(string: link.url) { openURL(url) }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
            }
        }
    }

    @ViewBuilder private var followButton: some View {
        if isAdmin, let d = model.onItsWay {
            Button("Follow on Lock Screen", systemImage: "lock.iphone") { Task { await LiveActivityController.shared.follow(d, app: app) } }
                .buttonStyle(QuietButtonStyle())
                .accessibilityIdentifier("follow-lock-screen")
        }
    }

    @ViewBuilder private func progressStrip(_ info: TitleInfo) -> some View {
        if let r = model.request {
            VStack(alignment: .leading, spacing: 8) {
                if r.state == .declined {
                    StateLine(text: r.stateText, tone: .needsYou)
                } else {
                    let steps = ["Asked", "Approved", "Searching", "Downloading", "Ready"]
                    let at: Int = switch r.state {
                    case .pending: 0
                    case .unreleased, .searching, .looking: 2
                    case .downloading: 3
                    case .ready: 4
                    default: 1
                    }
                    HStack(spacing: 4) {
                        ForEach(Array(steps.enumerated()), id: \.offset) { i, name in
                            VStack(spacing: 4) {
                                Capsule().fill(i <= at ? (at == 4 ? Color.readyTeal : Color.downloadBlue) : Color.line).frame(height: 4)
                                Text(name).font(.caption2).foregroundStyle(i == at ? Color.textPrimary : Color.dim)
                            }
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Progress: \(steps[at])")
                    StateLine(text: r.stateText, tone: r.state == .ready ? .ready : .downloading)
                }
            }
            .padding(12)
            .background(Color.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    @ViewBuilder private var fileLine: some View {
        if let m = model.movie.value, let f = m.files.first {
            PanelCard {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(f.quality.label).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                        Text([f.quality.source, f.quality.codec, f.quality.group].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.muted)
                    }
                    Spacer()
                    Text(ByteCountFormatter.string(fromByteCount: Int64(f.sizeBytes), countStyle: .file)).font(.subheadline).foregroundStyle(.soft)
                }
                .padding(12)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func adminControls(_ info: TitleInfo) -> some View {
        PanelCard {
            Toggle(isOn: Binding(get: { info.wanted }, set: { v in Task { await model.setWanted(app, v) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Wanted").font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                    Text(info.wanted ? "Marquee looks for it by itself." : "Marquee leaves it alone.").font(.caption).foregroundStyle(.muted)
                }
            }
            .tint(.amber)
            .padding(12)
            Divider().overlay(Color.line)
            Menu {
                Button("Let the rules choose") { Task { await model.setProfile(app, nil) } }
                ForEach(model.profiles) { p in
                    Button(p.name) { Task { await model.setProfile(app, p.key) } }
                }
            } label: {
                HStack {
                    Text("Quality profile").foregroundStyle(.textPrimary)
                    Spacer()
                    Text((model.profiles.first { $0.key == info.profile }?.name ?? info.profile) + (info.profileByHand ? "" : " · by the rules")).font(.footnote).foregroundStyle(.muted)
                    Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.dim)
                }
                .padding(12).frame(minHeight: 50)
            }
            Divider().overlay(Color.line)
            Button { showCopies = true } label: {
                HStack {
                    Text("Copies we found").foregroundStyle(.textPrimary)
                    Spacer()
                    Text("Look now ›").font(.footnote).foregroundStyle(.amber)
                }
                .padding(12).frame(minHeight: 50)
            }
            .accessibilityIdentifier("copies")
        }
    }

    private func seasons(_ show: ShowDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "Seasons")
            ForEach(show.seasons) { season in
                DisclosureGroup {
                    VStack(spacing: 0) {
                        ForEach(season.episodes) { ep in
                            Button {
                                if isAdmin { episode = EpisodeTarget(season: season.season, episode: ep) }
                            } label: { episodeRow(ep, show: show) }
                            .buttonStyle(.plain)
                            .disabled(!isAdmin)
                            if ep.id != season.episodes.last?.id { Divider().overlay(Color.line) }
                        }
                        if isAdmin {
                            HStack {
                                Button("Want every episode") { Task { await model.setSeasonWanted(app, season: season.season, true) } }
                                Spacer()
                                Button("Want none") { Task { await model.setSeasonWanted(app, season: season.season, false) } }
                            }
                            .font(.footnote.weight(.semibold)).foregroundStyle(.amber).padding(.top, 8)
                        }
                    }
                } label: {
                    HStack {
                        Text(season.season == 0 ? "Specials" : "Season \(season.season)").font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                        Spacer()
                        Text("\(season.have) of \(max(season.aired, season.have))").font(.footnote).foregroundStyle(season.have >= season.aired ? Color.readyTeal : Color.muted)
                    }
                    .frame(minHeight: 44)
                }
                .tint(.soft)
                .padding(.horizontal, 12)
                .background(Color.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
    }

    private func episodeRow(_ ep: EpisodeView, show: ShowDetail) -> some View {
        let (text, tone) = Self.episodeState(ep, showWanted: show.monitored)
        return HStack(alignment: .top, spacing: 10) {
            Text("\(ep.episode)").font(.footnote.weight(.semibold)).foregroundStyle(.dim).frame(width: 24, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(ep.title ?? "Episode \(ep.episode)").font(.subheadline).foregroundStyle(.textPrimary).lineLimit(2).multilineTextAlignment(.leading)
                StateLine(text: text, tone: tone)
            }
            Spacer(minLength: 0)
            if isAdmin { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.dim) }
        }
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    static func episodeState(_ ep: EpisodeView, showWanted: Bool) -> (String, Tone) {
        if let f = ep.file { return ("Have it · \(f.quality.label)", .ready) }
        if !ep.aired { return ("Not out yet" + (ep.airDate.map { " · \($0)" } ?? ""), .neutral) }
        if showWanted && ep.wanted { return ("Missing · Marquee is looking", .needsYou) }
        return ("Not wanted", .neutral)
    }

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "History")
            PanelCard {
                ForEach(model.history) { h in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(h.label).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                        Text([Format.ago(h.at), h.quality, h.source].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.muted)
                        if let d = h.detail { Text(d).font(.caption).foregroundStyle(.soft) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .accessibilityElement(children: .combine)
                    if h.id != model.history.last?.id { Divider().overlay(Color.line) }
                }
            }
        }
    }

    @ViewBuilder private var problemsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !model.issues.isEmpty {
                SectionTitle(text: "Problems reported")
                PanelCard {
                    ForEach(model.issues) { i in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(i.problemText)\(i.where.map { " · \($0)" } ?? "")").font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                            Text("\(i.by) · \(Format.ago(i.createdAt)) · \(i.isOpen ? "Open" : "Fixed")").font(.caption).foregroundStyle(i.isOpen ? Color.warn : Color.readyTeal)
                            if !i.message.isEmpty { Text(i.message).font(.caption).foregroundStyle(.soft) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            Button("Something wrong?") { showIssue = true }
                .buttonStyle(QuietButtonStyle())
                .accessibilityIdentifier("something-wrong")
        }
    }

    private var moreMenu: some View {
        Menu {
            if isAdmin { Button("Look for copies again", systemImage: "magnifyingglass") { showCopies = true } }
            Button("Open in the web app", systemImage: "safari") {
                Task {
                    let base = await app.client.activeAddress
                    let path = model.route.kind == .movie ? "/movies/\(model.route.id)" : "/shows/\(model.route.id)"
                    if let url = URL(string: base.absoluteString + path) { openURL(url) }
                }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).frame(width: 44, height: 44)
        }
        .accessibilityLabel("More")
    }
}
