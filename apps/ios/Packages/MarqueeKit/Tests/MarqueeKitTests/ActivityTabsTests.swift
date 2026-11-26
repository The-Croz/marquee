import Testing
@testable import MarqueeKit

@Suite struct ActivityTabsTests {
    @Test func adminsSeeDownloadsAndRequests() {
        #expect(ActivityTabs.sections(for: .admin) == [.downloads, .requests])
    }

    @Test func membersSeeOnlyRequests() {
        #expect(ActivityTabs.sections(for: .member) == [.requests])
    }

    @Test func kidsSeeNothing() {
        #expect(ActivityTabs.sections(for: .kid).isEmpty)
        #expect(ActivityTabs.sections(for: .unknown("guest")).isEmpty)
    }
}
