import Foundation
import Testing
@testable import MarqueeKit

@Suite struct ServerAddressTests {
    @Test func anIPGetsHttp() throws {
        #expect(try ServerAddress.normalize("192.168.1.20:9797").absoluteString == "http://192.168.1.20:9797")
    }

    @Test func aNameGetsHttps() throws {
        #expect(try ServerAddress.normalize("marquee.example.com").absoluteString == "https://marquee.example.com")
    }

    @Test func aPathAndSlashAreDropped() throws {
        #expect(try ServerAddress.normalize("https://m.example.com/settings/").absoluteString == "https://m.example.com")
    }

    @Test func httpOnTheInternetIsRefused() {
        #expect(throws: AddressError.needsHTTPS) { try ServerAddress.normalize("http://m.example.com") }
    }

    @Test func dotLocalIsAtHome() throws {
        #expect(try ServerAddress.normalize("tower.local:9797").absoluteString == "http://tower.local:9797")
        #expect(try ServerAddress.normalize("localhost:9797").absoluteString == "http://localhost:9797")
    }

    @Test func emptyIsRefused() {
        #expect(throws: AddressError.empty) { try ServerAddress.normalize("   ") }
    }

    @Test func spacesAroundAreIgnored() throws {
        #expect(try ServerAddress.normalize("  10.0.0.5:9797\n").absoluteString == "http://10.0.0.5:9797")
    }

    @Test func displayShowsHostAndPort() {
        #expect(ServerAddress.display(URL(string: "http://192.168.1.20:9797")!) == "192.168.1.20:9797")
        #expect(ServerAddress.display(URL(string: "https://m.example.com")!) == "m.example.com")
    }
}
