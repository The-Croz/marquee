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
