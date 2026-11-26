import Foundation
import Testing
@testable import MarqueeKit

/// Every response the server saved as a fixture (apps/server/test/appFixtures.test.ts)
/// must decode into the Swift models. If the server's shape drifts, these fail.
enum Fixture {
    static func data(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
            throw FixtureError.missing(name)
        }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: data(name))
    }

    enum FixtureError: Error { case missing(String) }
}

@Suite struct FixtureDecodingTests {
    @Test func health() throws {
        let h = try Fixture.decode(Health.self, "health")
        #expect(h.ok)
    }

    @Test func authStatus() throws {
        let s = try Fixture.decode(AuthStatus.self, "auth-status")
        #expect(s.user?.username == "josh")
        #expect(s.providers.password)
        #expect(!s.providers.oidc.enabled)
        let out = try Fixture.decode(AuthStatus.self, "auth-status-signed-out")
        #expect(out.user == nil)
    }

    @Test func appSignIn() throws {
        let s = try Fixture.decode(AppSignIn.self, "app-sign-in")
        #expect(s.token == "<token>")
        #expect(s.user.role == .admin)
    }

    @Test func badCredentials() throws {
        let e = try Fixture.decode(ApiError.self, "error-bad-credentials")
        #expect(e.error == "bad_credentials")
        #expect(e.message == "Wrong username or password.")
    }

    @Test func me() throws {
        #expect(try Fixture.decode(MeResponse.self, "me").user.displayName == "Josh")
    }

    @Test func devices() throws {
        let d = try Fixture.decode(DevicesResponse.self, "devices").devices
        #expect(d.count == 1)
        #expect(d[0].current && d[0].signedIn)
    }

    @Test func pushEvents() throws {
        var p = try Fixture.decode(DevicePushEvents.self, "push-events")
        // Sections come in the order the web page uses, each holding its own messages.
        #expect(p.sections.map(\.name) == ["Requests", "Downloads", "Problems", "Watching", "Marquee"])
        #expect(p.sections.allSatisfy { section in section.events.allSatisfy { $0.group == section.name } })
        #expect(p.sections.flatMap(\.events).count == p.events.count)
        #expect(p.on.contains("request_pending"))
        #expect(!p.on.contains("stream_started"))
        p.set("stream_started", on: true)
        p.set("stream_started", on: true)
        p.set("request_pending", on: false)
        #expect(p.on.filter { $0 == "stream_started" }.count == 1)
        #expect(!p.on.contains("request_pending"))
    }

    @Test func aGroupThisAppDoesNotKnowStillShows() {
        let event = DevicePushEvents.Event(key: "new_thing", group: "Brand new", label: "A new thing", description: "Something.")
        let p = DevicePushEvents(events: [event], on: [])
        #expect(p.sections.map(\.name) == ["Brand new"])
    }

    @Test func homeCarriesTheBannerSlidesAndStreams() throws {
        let h = try Fixture.decode(HomeData.self, "home-admin")
        #expect(!h.slides.isEmpty)
        #expect(h.slides == h.heroes)
    }

    @Test func aServerFromBeforeTheRotatingBannerStillShowsOne() throws {
        var h = try Fixture.decode(HomeData.self, "home-admin")
        h.heroes = nil
        #expect(h.slides.count == 1)
        h.hero = nil
        #expect(h.slides.isEmpty)
    }

    @Test func homeForAnAdmin() throws {
        let h = try Fixture.decode(HomeData.self, "home-admin")
        #expect(h.needsYou.count == 2)
        #expect(h.needsYou.contains { $0.approveId != nil })
        #expect(h.onItsWay.first?.percent == 42)
        #expect(h.hero?.title == "Wicked")
        #expect(h.hero?.backdropPath == "/wicked-bg.jpg")
        #expect(h.recent.count == 1)
        #expect(!h.recentRequests.isEmpty)
    }

    @Test func homeForAMemberAndAKid() throws {
        #expect(try Fixture.decode(HomeData.self, "home-member").needsYou.isEmpty)
        let kid = try Fixture.decode(HomeData.self, "home-kid")
        #expect(kid.myRequests.first?.state == .pending)
    }

    @Test func downloads() throws {
        let d = try Fixture.decode(DownloadsView.self, "downloads")
        #expect(d.items.count == 2)
        #expect(d.items.contains { $0.state == .downloading && $0.progress == 0.42 })
        #expect(d.items.contains { $0.status.tone == .warn })
        #expect(d.problem == nil)
        #expect(try Fixture.decode(DownloadsSummary.self, "downloads-summary").active == 2)
    }

    @Test func requests() throws {
        let all = try Fixture.decode(RequestsResponse.self, "requests-admin").items
        #expect(Set(all.map(\.state)) == [.declined, .pending, .downloading])
        let declined = all.first { $0.state == .declined }
        #expect(declined?.reason == "We have it on disc.")
        #expect(try Fixture.decode(RequestsResponse.self, "requests-member").items.count >= 1)
        #expect(try Fixture.decode(RequestsSummary.self, "requests-summary").pending == 1)
    }

    @Test func approvedAndDeclined() throws {
        #expect(try Fixture.decode(RequestView.self, "request-approved").state == .downloading)
        #expect(try Fixture.decode(RequestView.self, "request-declined").state == .declined)
    }

    @Test func unknownRequestStateDecodes() throws {
        let json = #"{"id":1,"kind":"movie","tmdbId":1,"title":"X","year":null,"posterPath":null,"seasons":null,"requestedBy":null,"state":"something-new","stateText":"","searchNote":null,"profile":null,"reason":null,"decidedBy":null,"createdAt":1,"decidedAt":null,"href":null}"#
        let r = try JSONDecoder().decode(RequestView.self, from: Data(json.utf8))
        #expect(r.state == .unknown("something-new"))
    }

    @Test func unknownRoleDecodes() throws {
        let role = try JSONDecoder().decode(Role.self, from: Data(#""guest""#.utf8))
        #expect(role == .unknown("guest"))
    }

    @Test func plexAnswers() throws {
        let ok = #"{"status":"ok","user":{"id":1,"username":"a","displayName":"A","role":"kid","linked":{"plex":true,"oidc":false,"password":false,"jellyfin":false}},"token":"t"}"#
        guard case .ok(let user, let token) = try JSONDecoder().decode(PlexPinCheck.self, from: Data(ok.utf8)) else { Issue.record("not ok"); return }
        #expect(user.role == .kid && token == "t")
        #expect(try JSONDecoder().decode(PlexPinCheck.self, from: Data(#"{"status":"pending"}"#.utf8)) == .pending)
    }
}

@Suite struct BrowseFixtureTests {
    @Test func libraryLists() throws {
        let movies = try Fixture.decode(LibraryList.self, "movies").items
        #expect(movies.count == 2)
        #expect(movies.first { $0.title == "Up" }?.badge == "Missing")
        #expect(try Fixture.decode(LibraryList.self, "shows").items.count == 1)
        #expect(try Fixture.decode(LibraryList.self, "movies-kid").items.allSatisfy { $0.certification != "PG-13" })
    }

    @Test func titlePages() throws {
        let m = try Fixture.decode(MovieDetail.self, "movie-detail")
        #expect(m.files.first?.quality.label == "4K HDR")
        let s = try Fixture.decode(ShowDetail.self, "show-detail")
        #expect(s.seasons.count == 2)
        #expect(s.seasons[0].episodes[0].file != nil)
        #expect(try Fixture.decode(WatchLinks.self, "movie-watch").links.isEmpty)
        let e = try Fixture.decode(EpisodeDetailView.self, "episode-detail")
        #expect(e.files.count == 1)
    }

    @Test func discover() throws {
        let page = try Fixture.decode(DiscoverPage.self, "discover")
        #expect(!page.rows.isEmpty && !page.services.isEmpty)
        #expect(page.hero.first?.state == .inLibrary)
        _ = try Fixture.decode(DiscoverPage.self, "discover-kids")
        let movie = try Fixture.decode(DiscoverTitle.self, "discover-title-movie")
        #expect(movie.card.title == "Wicked")
        #expect(movie.canRequest)
        let show = try Fixture.decode(DiscoverTitle.self, "discover-title-series")
        #expect(show.card.kind == "series")
        #expect(try Fixture.decode(SeasonPreview.self, "discover-season").episodes.count == 2)
        #expect(try Fixture.decode(DiscoverSearchResults.self, "discover-search").results.count == 1)
        #expect(try Fixture.decode(SearchResults.self, "library-search").results.first?.libraryId == 1)
    }

    @Test func calendarCopiesHistoryAndProblems() throws {
        let cal = try Fixture.decode(CalendarView.self, "calendar")
        #expect(cal.items.first?.state == "coming")
        let copies = try Fixture.decode(CopiesResult.self, "copies")
        #expect(copies.copies.first?.accepted == true)
        #expect(copies.copies.first?.vsYours?.better == true)
        #expect(try Fixture.decode(HistoryView.self, "history-title").items.count == 1)
        #expect(try Fixture.decode(IssuesView.self, "issues-title").items.first?.isOpen == true)
        #expect(try Fixture.decode(ProfilesView.self, "profiles").profiles.first?.key == "cinema")
    }
}

@Suite struct ManageFixtureTests {
    @Test func watching() throws {
        let now = try Fixture.decode(ActivityNow.self, "activity-now")
        #expect(now.sessions.first?.transcoding == true)
        let stats = try Fixture.decode(ActivityStats.self, "activity-stats")
        #expect(stats.perDay.count == 30)
        #expect(stats.users.first?.name == "Mia")
        #expect(try Fixture.decode(PeopleResponse.self, "activity-people").people.first?.devices == ["Living room TV"])
    }

    @Test func healthSourcesPeopleAndCare() throws {
        let h = try Fixture.decode(HealthView.self, "system-health")
        #expect(h.problems == 3)
        #expect(h.disks.contains { $0.needsYou })
        #expect(!h.jobs.isEmpty)
        let s = try Fixture.decode(SourcesView.self, "sources")
        #expect(s.sources.first?.isWorking == true)
        let u = try Fixture.decode(UsersResponse.self, "users").users
        #expect(u.map(\.role) == [.admin, .member, .kid])
        #expect(try Fixture.decode(UnmatchedResponse.self, "unmatched").items.first?.candidates.first?.title == "Up")
        #expect(try Fixture.decode(LeftOutResponse.self, "left-out").items.isEmpty)
    }
}
