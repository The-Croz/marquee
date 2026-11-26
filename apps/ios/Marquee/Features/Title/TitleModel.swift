import MarqueeKit
import Observation
import SwiftUI

/// What the title page needs from a movie or a show, whichever it is.
struct TitleInfo {
    var tmdbId: Int
    var title: String
    var year: Int?
    var overview: String?
    var posterPath: String?
    var posterColor: String?
    var backdropPath: String?
    var certification: String?
    var genres: [String]
    var wanted: Bool
    var profile: String
    var profileByHand: Bool
    /// "2 h 46 min" for a movie, "Apple TV+ · Returning Series" for a show.
    var line: String
}

@Observable @MainActor
final class TitleModel {
    let route: TitleRoute
    let movie = Loader<MovieDetail>()
    let show = Loader<ShowDetail>()
    private(set) var links: [WatchLink] = []
    private(set) var request: RequestView?
    private(set) var profiles: [ProfileSummary] = []
    private(set) var history: [HistoryItem] = []
    /// A download of this title on its way (admins), for Follow on Lock Screen.
    private(set) var onItsWay: DownloadView?
    private(set) var issues: [IssueView] = []
    var problem: String?

    init(route: TitleRoute) {
        self.route = route
    }

    var base: String { route.kind == .movie ? "/api/movies/\(route.id)" : "/api/shows/\(route.id)" }
    var loaded: Bool { route.kind == .movie ? movie.value != nil : show.value != nil }

    var info: TitleInfo? {
        if let m = movie.value {
            let runtime = m.runtime.map { $0 >= 60 ? "\($0 / 60) h \($0 % 60) min" : "\($0) min" }
            return TitleInfo(tmdbId: m.tmdbId, title: m.title, year: m.year, overview: m.overview, posterPath: m.posterPath, posterColor: m.posterColor, backdropPath: m.backdropPath, certification: m.certification, genres: m.genres, wanted: m.monitored, profile: m.profile, profileByHand: m.profileByHand, line: runtime ?? "")
        }
        if let s = show.value {
            return TitleInfo(tmdbId: s.tmdbId, title: s.title, year: s.year, overview: s.overview, posterPath: s.posterPath, posterColor: s.posterColor, backdropPath: s.backdropPath, certification: s.certification, genres: s.genres, wanted: s.monitored, profile: s.profile, profileByHand: s.profileByHand, line: [s.network, s.status].compactMap { $0 }.joined(separator: " · "))
        }
        return nil
    }

    var activeProblem: MarqueeError? { route.kind == .movie ? movie.problem : show.problem }
    var forbidden: Bool { route.kind == .movie ? movie.forbidden : show.forbidden }

    func load(_ app: AppModel) async {
        let isAdmin = app.user?.role == .admin
        if route.kind == .movie {
            await movie.run(app) { () async throws(MarqueeError) -> MovieDetail in try await app.client.get(self.base) }
        } else {
            await show.run(app) { () async throws(MarqueeError) -> ShowDetail in try await app.client.get(self.base) }
        }
        guard let info else { return }
        if let answer: WatchLinks = try? await app.client.get("\(base)/watch") { links = answer.links }
        if let answer: RequestsResponse = try? await app.client.get("/api/requests?scope=\(isAdmin ? "all" : "mine")") {
            let kind: RequestKind = route.kind == .movie ? .movie : .series
            request = answer.items.first { $0.tmdbId == info.tmdbId && $0.kind == kind }
        }
        let issueKind = route.kind == .movie ? "movie" : "series"
        if let answer: IssuesView = try? await app.client.get("/api/issues/title/\(issueKind)/\(route.id)") { issues = answer.items }
        if isAdmin {
            if let answer: ProfilesView = try? await app.client.get("/api/settings/profiles") {
                profiles = answer.profiles.filter { $0.kind == (route.kind == .movie ? "movie" : "tv") }
            }
            let q = route.kind == .movie ? "movieId" : "seriesId"
            if let answer: HistoryView = try? await app.client.get("/api/history?\(q)=\(route.id)&limit=20") { history = answer.items }
            if let answer: DownloadsView = try? await app.client.get("/api/downloads?\(q)=\(route.id)") {
                onItsWay = answer.items.first { $0.state == .sent || $0.state == .downloading }
            }
        }
    }

    struct Wanted: Encodable { var wanted: Bool }
    /// `{"profile": null}` hands the title back to the rules; the key must be there even when empty.
    struct Profile: Encodable {
        var profile: String?
        enum Keys: String, CodingKey { case profile }
        func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: Keys.self)
            try c.encode(profile, forKey: .profile)
        }
    }
    struct Ok: Decodable, Sendable {}

    private func write(_ app: AppModel, _ method: String, _ path: String, _ body: some Encodable & Sendable) async {
        do {
            let _: Ok = try await app.client.send(method, path, body: body)
            await load(app)
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }

    func setWanted(_ app: AppModel, _ wanted: Bool) async { await write(app, "PUT", "\(base)/wanted", Wanted(wanted: wanted)) }
    func setProfile(_ app: AppModel, _ key: String?) async { await write(app, "PUT", "\(base)/profile", Profile(profile: key)) }
    func setSeasonWanted(_ app: AppModel, season: Int, _ wanted: Bool) async { await write(app, "PUT", "\(base)/seasons/\(season)/wanted", Wanted(wanted: wanted)) }
    func setEpisodeWanted(_ app: AppModel, season: Int, episode: Int, _ wanted: Bool) async { await write(app, "PUT", "\(base)/seasons/\(season)/episodes/\(episode)/wanted", Wanted(wanted: wanted)) }

    struct Report: Encodable {
        var kind: String
        var id: Int
        var season: Int?
        var episode: Int?
        var problem: String
        var message: String
    }

    func report(_ app: AppModel, problem kind: String, message: String) async -> Bool {
        let body = Report(kind: route.kind == .movie ? "movie" : "series", id: route.id, season: nil, episode: nil, problem: kind, message: message)
        do {
            let _: IssueView = try await app.client.send("POST", "/api/issues", body: body)
            await load(app)
            return true
        } catch {
            if case .signedOut = error { app.handle(error); return false }
            problem = error.fullText
            return false
        }
    }
}
