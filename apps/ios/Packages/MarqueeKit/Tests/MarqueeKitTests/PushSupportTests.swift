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
}
