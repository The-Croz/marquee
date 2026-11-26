import Foundation
import Testing
@testable import MarqueeKit

@Suite struct TMDBImageTests {
    @Test func buildsTheAddress() {
        #expect(TMDBImage.url(path: "/abc.jpg", size: .w342)?.absoluteString == "https://image.tmdb.org/t/p/w342/abc.jpg")
        #expect(TMDBImage.url(path: "abc.jpg", size: .w342)?.absoluteString == "https://image.tmdb.org/t/p/w342/abc.jpg")
        #expect(TMDBImage.url(path: "/b.jpg", size: .w1280)?.absoluteString == "https://image.tmdb.org/t/p/w1280/b.jpg")
    }

    @Test func noPathMeansNoPicture() {
        #expect(TMDBImage.url(path: nil, size: .w185) == nil)
        #expect(TMDBImage.url(path: "", size: .w185) == nil)
    }
}
