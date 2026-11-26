import Foundation
import Testing
@testable import MarqueeKit

private let phone = AppDeviceInput(id: "phone-aaaa-1111", name: "Test iPhone")

private func client(_ home: String, outside: String? = nil, token: String? = "tok") -> (APIClient, MemoryTokenStore) {
    let store = MemoryTokenStore(token)
    let addresses = ServerAddresses(home: URL(string: "http://\(home)")!, outside: outside.map { URL(string: "https://\($0)")! })
    return (APIClient(addresses: addresses, tokens: store, session: StubURLProtocol.session()), store)
}

private func json(_ text: String, status: Int = 200) -> StubURLProtocol.Reply { .init(status: status, body: Data(text.utf8)) }

@Suite struct APIClientTests {
    @Test func sendsTheBearerToken() async throws {
        let (api, _) = client("t-bearer.test")
        StubURLProtocol.answer(host: "t-bearer.test") { _ in json(#"{"ok":true,"version":"1"}"#) }
        _ = try await api.get("/api/health", as: Health.self)
        let sent = StubURLProtocol.requests(host: "t-bearer.test")[0]
        #expect(sent.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(sent.value(forHTTPHeaderField: "Accept") == "application/json")
    }

    @Test func fetchesAPictureWithTheToken() async throws {
        let (api, _) = client("t-picture.test")
        StubURLProtocol.answer(host: "t-picture.test") { _ in .init(status: 200, contentType: "image/png", body: Data("face".utf8)) }
        #expect(await api.picture("/api/avatars/1?v=ab") == Data("face".utf8))
        #expect(StubURLProtocol.requests(host: "t-picture.test")[0].value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        // Only Marquee's own pictures: the token never goes anywhere else.
        #expect(await api.picture("@evil.test/x") == nil)
        StubURLProtocol.answer(host: "t-picture.test") { _ in .init(status: 404, body: Data("{}".utf8)) }
        #expect(await api.picture("/api/avatars/2") == nil)
    }

    @Test func writesAreJSON() async throws {
        let (api, _) = client("t-json.test")
        StubURLProtocol.answer(host: "t-json.test") { _ in json("{}") }
        let _: DownloadsSummary? = try? await api.post("/api/requests/1/approve")
        let sent = StubURLProtocol.requests(host: "t-json.test")[0]
        #expect(sent.httpMethod == "POST")
        #expect(sent.value(forHTTPHeaderField: "Content-Type") == "application/json")
    }

    @Test func aServerErrorCarriesItsMessage() async throws {
        let (api, _) = client("t-error.test", token: nil)
        let body = try Fixture.data("error-bad-credentials")
        StubURLProtocol.answer(host: "t-error.test") { _ in .init(status: 401, body: body) }
        await #expect(throws: MarqueeError.server(code: "bad_credentials", message: "Wrong username or password.")) {
            try await api.signIn(username: "josh", password: "nope", device: phone)
        }
    }

    @Test func a401ElsewhereSignsOut() async throws {
        let (api, store) = client("t-401.test")
        StubURLProtocol.answer(host: "t-401.test") { _ in .init(status: 401, body: Data(#"{"error":"unauthenticated","message":"Please sign in."}"#.utf8)) }
        await #expect(throws: MarqueeError.signedOut) { try await api.get("/api/home", as: HomeData.self) }
        #expect(store.read() == nil)
    }

    @Test func htmlMeansPangolin() async throws {
        let (api, _) = client("t-html.test")
        StubURLProtocol.answer(host: "t-html.test") { _ in .init(status: 200, contentType: "text/html; charset=utf-8", body: Data("<html>Sign in</html>".utf8)) }
        await #expect(throws: MarqueeError.pangolinInTheWay) { try await api.get("/api/home", as: HomeData.self) }
    }

    /// Leaving a screen cancels what it was loading. That's not a fault, and nothing should say it is.
    @Test func aCancelledRequestSaysSoAndNothingMore() async {
        let (api, _) = client("t-cancel.test")
        StubURLProtocol.answer(host: "t-cancel.test") { _ in json(#"{"ok":true,"version":"1"}"#) }
        let task = Task { () -> MarqueeError? in
            withUnsafeCurrentTask { $0?.cancel() }
            do throws(MarqueeError) {
                _ = try await api.get("/api/health", as: Health.self)
                return nil
            } catch {
                return error
            }
        }
        #expect(await task.value == .cancelled)
    }

    @Test func fallsBackToOutside() async throws {
        let (api, _) = client("t-home.test", outside: "t-outside.test")
        StubURLProtocol.answer(host: "t-home.test") { _ in throw URLError(.cannotConnectToHost) }
        StubURLProtocol.answer(host: "t-outside.test") { _ in json(#"{"ok":true,"version":"2"}"#) }
        let h = try await api.get("/api/health", as: Health.self)
        #expect(h.version == "2")
        #expect(await api.activeAddress.host == "t-outside.test")
        // It stays on the Outside address (no wasted wait at Home) until the app comes back to the front.
        _ = try await api.get("/api/health", as: Health.self)
        #expect(StubURLProtocol.requests(host: "t-home.test").count == 1)
        StubURLProtocol.answer(host: "t-home.test") { _ in json(#"{"ok":true,"version":"3"}"#) }
        await api.backHome()
        #expect(try await api.get("/api/health", as: Health.self).version == "3")
        #expect(await api.activeAddress.host == "t-home.test")
    }

    @Test func aWriteThatTimedOutIsNotSentAgainElsewhere() async throws {
        let (api, _) = client("t-slow.test", outside: "t-slow-out.test")
        StubURLProtocol.answer(host: "t-slow.test") { _ in throw URLError(.timedOut) }
        StubURLProtocol.answer(host: "t-slow-out.test") { _ in json("{}") }
        let _: DownloadsSummary? = try? await api.post("/api/requests/1/approve")
        #expect(StubURLProtocol.requests(host: "t-slow-out.test").isEmpty)
    }

    @Test func aWriteThatNeverConnectedMovesOn() async throws {
        let (api, _) = client("t-dead.test", outside: "t-dead-out.test")
        StubURLProtocol.answer(host: "t-dead.test") { _ in throw URLError(.cannotConnectToHost) }
        StubURLProtocol.answer(host: "t-dead-out.test") { _ in json("{}") }
        let _: DownloadsSummary? = try? await api.post("/api/requests/1/approve")
        #expect(StubURLProtocol.requests(host: "t-dead-out.test").count == 1)
    }

    @Test func noOutsideAddressMeansUnreachableHome() async throws {
        let (api, _) = client("t-down.test")
        StubURLProtocol.answer(host: "t-down.test") { _ in throw URLError(.cannotConnectToHost) }
        await #expect(throws: MarqueeError.unreachable(URL(string: "http://t-down.test")!)) { try await api.get("/api/health", as: Health.self) }
    }

    @Test func signInWithoutATokenIsTooOld() async throws {
        let (api, store) = client("t-old.test", token: nil)
        let user = try Fixture.data("me")
        StubURLProtocol.answer(host: "t-old.test") { _ in .init(body: user) }
        await #expect(throws: MarqueeError.tooOld) { try await api.signIn(username: "josh", password: "x", device: phone) }
        #expect(store.read() == nil)
    }

    @Test func signInStoresTheToken() async throws {
        let (api, store) = client("t-in.test", token: nil)
        let body = try Fixture.data("app-sign-in")
        StubURLProtocol.answer(host: "t-in.test") { _ in .init(body: body) }
        let user = try await api.signIn(username: "josh", password: "x", device: phone)
        #expect(user.username == "josh")
        #expect(store.read() == "<token>")
    }

    @Test func theTextsSayWhatToDo() {
        #expect(MarqueeError.signedOut.title == "You were signed out.")
        #expect(MarqueeError.signedOut.advice == "Sign in again.")
        #expect(MarqueeError.pangolinInTheWay.advice == "In Pangolin, add a rule to the Marquee resource that skips sign-in for /api/*.")
        #expect(MarqueeError.unreachable(URL(string: "http://192.168.1.20:9797")!).title == "Can't reach Marquee at 192.168.1.20:9797.")
    }
}
