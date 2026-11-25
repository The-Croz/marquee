import Foundation
import Testing
@testable import MarqueeKit

@Suite struct DeepLinkTests {
    @Test func titles() {
        #expect(DeepLink(url: URL(string: "marquee://title/movie/12")!) == .title(TitleRoute(kind: .movie, id: 12)))
        #expect(DeepLink(url: URL(string: "marquee://title/show/3")!) == .title(TitleRoute(kind: .show, id: 3)))
    }

    @Test func sections() {
        #expect(DeepLink(url: URL(string: "marquee://requests")!) == .requests)
        #expect(DeepLink(url: URL(string: "marquee://downloads")!) == .downloads)
    }

    @Test func junkIsNothing() {
        #expect(DeepLink(url: URL(string: "marquee://title/film/12")!) == nil)
        #expect(DeepLink(url: URL(string: "marquee://title/movie")!) == nil)
        #expect(DeepLink(url: URL(string: "https://example.com/title/movie/1")!) == nil)
        #expect(DeepLink(url: URL(string: "marquee://signed-in?code=x")!) == nil)
    }

    @Test func webPaths() {
        #expect(TitleRoute(webPath: "/movies/12") == TitleRoute(kind: .movie, id: 12))
        #expect(TitleRoute(webPath: "/shows/3") == TitleRoute(kind: .show, id: 3))
        #expect(TitleRoute(webPath: "/downloads") == nil)
        #expect(TitleRoute(webPath: nil) == nil)
    }
}
