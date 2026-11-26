import Testing
@testable import MarqueeKit

@Suite struct SSEParserTests {
    @Test func anEventEndsAtABlankLine() {
        var p = SSEParser()
        #expect(p.line("event: sessions") == nil)
        #expect(p.line("data: {\"a\":1}") == nil)
        #expect(p.line("") == SSEParser.Event(name: "sessions", data: "{\"a\":1}"))
    }

    @Test func manyDataLinesJoin() {
        var p = SSEParser()
        _ = p.line("data: one")
        _ = p.line("data: two")
        #expect(p.line("") == SSEParser.Event(name: "message", data: "one\ntwo"))
    }

    @Test func pingsWithNoDataAreSkippedAndStateResets() {
        var p = SSEParser()
        _ = p.line("event: ping")
        _ = p.line("data: ")
        // "data:" with nothing is still data (an empty string): the server's ping sends an empty one.
        #expect(p.line("") == SSEParser.Event(name: "ping", data: ""))
        #expect(p.line("") == nil)
        _ = p.line(": a comment")
        #expect(p.line("") == nil)
        _ = p.line("data: x")
        #expect(p.line("") == SSEParser.Event(name: "message", data: "x"))
    }
}
