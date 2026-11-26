import Foundation
import Testing
@testable import MarqueeKit

@Suite struct PushSupportTests {
    @Test func tokenAsHex() {
        #expect(PushSupport.hex(Data([0x00, 0xAB, 0x0F, 0xFF])) == "00ab0fff")
    }

    @Test func registrationBodyMatchesTheServer() throws {
        let body = PushSupport.Registration(token: "ab12", debug: true)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: String]
        #expect(json == ["token": "ab12", "environment": "sandbox"])
        #expect(PushSupport.Registration(token: "ab12", debug: false).environment == "production")
    }

    @Test func approveAndTurnDownNeedTheRequest() {
        #expect(PushSupport.action(actionID: "approve", userInfo: ["requestId": 7]) == .approve(requestId: 7))
        #expect(PushSupport.action(actionID: "turndown", userInfo: ["requestId": NSNumber(value: 9)]) == .turnDown(requestId: 9))
        #expect(PushSupport.action(actionID: "approve", userInfo: [:]) == .nothing)
    }

    @Test func tappingOpensTheLink() {
        let info: [AnyHashable: Any] = ["link": "https://marquee.example.com/movies/12"]
        #expect(PushSupport.action(actionID: "com.apple.UNNotificationDefaultActionIdentifier", userInfo: info) == .open(.title(TitleRoute(kind: .movie, id: 12))))
        #expect(PushSupport.action(actionID: "x", userInfo: ["link": "https://m/requests"]) == .open(.requests))
        #expect(PushSupport.action(actionID: "x", userInfo: ["link": "marquee://downloads"]) == .open(.downloads))
        #expect(PushSupport.action(actionID: "x", userInfo: [:]) == .nothing)
        #expect(PushSupport.action(actionID: "x", userInfo: ["link": "https://m/settings/sources"]) == .nothing)
    }

    @Test func coverArtOnlyFromTMDB() {
        #expect(PushSupport.isAllowedCoverArt("https://image.tmdb.org/t/p/w500/a.jpg"))
        #expect(!PushSupport.isAllowedCoverArt("http://image.tmdb.org/t/p/w500/a.jpg"))
        #expect(!PushSupport.isAllowedCoverArt("https://evil.example.com/a.jpg"))
        #expect(!PushSupport.isAllowedCoverArt(nil))
    }

    // Notifications are on unless the person switched them off on this iPhone.

    @Test func onByDefaultForSomeoneSignedIn() {
        #expect(PushSupport.plan(permission: .notAsked, switchedOff: false) == .ask)
        #expect(PushSupport.plan(permission: .allowed, switchedOff: false) == .register)
    }

    @Test func switchedOffStaysOff() {
        #expect(PushSupport.plan(permission: .allowed, switchedOff: true) == .off)
        #expect(PushSupport.plan(permission: .notAsked, switchedOff: true) == .off)
    }

    @Test func iOSSayingNoWins() {
        #expect(PushSupport.plan(permission: .denied, switchedOff: false) == .blocked)
        #expect(PushSupport.plan(permission: .denied, switchedOff: true) == .blocked)
    }

    @Test func theChoiceIsKeptForEachPerson() throws {
        let name = "push-choice-tests"
        let defaults = try #require(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        let choice = PushChoice(defaults: defaults)
        #expect(!choice.isOff(userID: 1))
        choice.set(off: true, userID: 1)
        #expect(PushChoice(defaults: defaults).isOff(userID: 1))
        #expect(!choice.isOff(userID: 2))
        choice.set(off: false, userID: 1)
        #expect(!choice.isOff(userID: 1))
        defaults.removePersistentDomain(forName: name)
    }

    @Test func aRequestOpensAsItsTitle() throws {
        let json = #"{"id":4,"kind":"movie","tmdbId":402431,"title":"Wicked","year":2024,"posterPath":"/w.jpg","state":"pending","stateText":"Waiting","createdAt":1}"#
        let request = try JSONDecoder().decode(RequestView.self, from: Data(json.utf8))
        let card = DiscoverCard(request: request)
        #expect(card.id == "movie-402431")
        #expect(card.title == "Wicked")
        #expect(card.posterPath == "/w.jpg")
        #expect(card.libraryId == nil)
    }
}
