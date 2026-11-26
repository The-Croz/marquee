import Foundation
import Testing
@testable import MarqueeKit

@Suite struct MainTabsTests {
    @Test func adminsGetRequestsAndDownloadsAsTabs() {
        #expect(MainTab.tabs(for: .admin) == [.home, .discover, .library, .requests, .downloads])
    }

    @Test func membersGetRequestsOnly() {
        #expect(MainTab.tabs(for: .member) == [.home, .discover, .library, .requests])
    }

    @Test func kidsGetBrowsing() {
        #expect(MainTab.tabs(for: .kid) == [.home, .discover, .library])
        #expect(MainTab.tabs(for: .unknown("guest")) == [.home, .discover, .library])
    }
}

@Suite struct PlaybackTests {
    @Test func saysWhereAStreamIs() {
        #expect(Playback.position(progress: 0.37, durationMs: 9_960_000) == "1:01:25 of 2:46:00")
        #expect(Playback.position(progress: 0.5, durationMs: 90_000) == "0:45 of 1:30")
        #expect(Playback.position(progress: 0.5, durationMs: nil) == "50%")
    }

    @Test func saysWhenItWillEndOnlyWhilePlaying() {
        let now = Date(timeIntervalSince1970: 1000)
        #expect(Playback.end(progress: 0.5, durationMs: 120_000, state: "playing", from: now) == now.addingTimeInterval(60))
        #expect(Playback.end(progress: 0.5, durationMs: 120_000, state: "paused", from: now) == nil)
        #expect(Playback.end(progress: 0.5, durationMs: nil, state: "playing", from: now) == nil)
    }
}
