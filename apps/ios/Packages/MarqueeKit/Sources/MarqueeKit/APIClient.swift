import Foundation

/// Sends `{}` where the server wants an empty JSON object.
public struct EmptyBody: Encodable, Sendable {
    public init() {}
}

/// Talks to Marquee: the address, the token, JSON in and out, and plain-English failures.
/// Tries the Home address first and falls back to the Outside one (and stays there until
/// `backHome()` is called, on the next return to the app).
public actor APIClient {
    private var addresses: ServerAddresses
    private let tokens: TokenStore
    private let session: URLSession
    private var onOutside = false
    /// Whether the last failed try never reached the server (so sending the same request elsewhere is safe).
    private var lastFailureWasConnecting = true
    private let decoder = JSONDecoder()

    public init(addresses: ServerAddresses, tokens: TokenStore, session: URLSession = .shared) {
        self.addresses = addresses
        self.tokens = tokens
        self.session = session
    }

    public var activeAddress: URL { onOutside ? (addresses.outside ?? addresses.home) : addresses.home }
    public var currentAddresses: ServerAddresses { addresses }

    public func use(_ addresses: ServerAddresses) {
        self.addresses = addresses
        onOutside = false
    }

    /// Called when the app comes back to the front: try Home first again.
    public func backHome() { onOutside = false }

    // MARK: Plain requests

    public func get<T: Decodable & Sendable>(_ path: String, as type: T.Type = T.self) async throws(MarqueeError) -> T {
        try await request("GET", path, body: nil, as: type)
    }

    public func send<T: Decodable & Sendable>(_ method: String, _ path: String, body: some Encodable & Sendable, as type: T.Type = T.self) async throws(MarqueeError) -> T {
        let data: Data
        do { data = try JSONEncoder().encode(body) } catch { throw .decoding("\(error)") }
        return try await request(method, path, body: data, as: type)
    }

    /// A write with an empty `{}` body.
    public func post<T: Decodable & Sendable>(_ path: String, as type: T.Type = T.self) async throws(MarqueeError) -> T {
        try await send("POST", path, body: EmptyBody(), as: type)
    }

    /// A picture Marquee serves (someone's profile picture). Nil when there isn't one or it can't be fetched.
    public func picture(_ path: String) async -> Data? {
        guard path.hasPrefix("/api/"), let url = URL(string: activeAddress.absoluteString + path) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 15)
        if let token = tokens.read() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse,
              http.statusCode == 200, http.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("image/") == true else { return nil }
        return data
    }

    // MARK: Signing in and out

    /// Marquee's own check, no sign-in needed: is something answering here, and which version?
    public func health(at url: URL) async throws(MarqueeError) -> Health {
        try await request("GET", "/api/health", body: nil, as: Health.self, only: url, signedIn: false)
    }

    public func authStatus() async throws(MarqueeError) -> AuthStatus {
        try await request("GET", "/api/auth/status", body: nil, as: AuthStatus.self, signedIn: false)
    }

    private struct Login: Encodable {
        var username: String
        var password: String
        var device: AppDeviceInput
    }

    private struct Exchange: Encodable {
        var code: String
        var verifier: String
        var device: AppDeviceInput
    }

    private struct PlexStart: Encodable {
        var device: AppDeviceInput
    }

    private struct PlexCheckBody: Encodable {
        var flowId: String
    }

    private struct MaybeToken: Decodable, Sendable {
        var token: String?
        var user: SessionUser
    }

    public func signIn(username: String, password: String, device: AppDeviceInput) async throws(MarqueeError) -> SessionUser {
        let body = Login(username: username, password: password, device: device)
        let answer: MaybeToken = try await send("POST", "/api/auth/login", body: body, signedIn: false)
        return try keep(answer)
    }

    /// Trades the one-time code from a browser sign-in (Pocket ID) for the token.
    public func exchange(code: String, verifier: String, device: AppDeviceInput) async throws(MarqueeError) -> SessionUser {
        let answer: MaybeToken = try await send("POST", "/api/auth/app-token", body: Exchange(code: code, verifier: verifier, device: device), signedIn: false)
        return try keep(answer)
    }

    public func jellyfinSignIn(username: String, password: String, device: AppDeviceInput) async throws(MarqueeError) -> SessionUser {
        let answer: MaybeToken = try await send("POST", "/api/auth/jellyfin", body: Login(username: username, password: password, device: device), signedIn: false)
        return try keep(answer)
    }

    public func plexStart(device: AppDeviceInput) async throws(MarqueeError) -> PlexPinStart {
        try await send("POST", "/api/auth/plex/start", body: PlexStart(device: device), signedIn: false)
    }

    /// Asks whether the Plex sign-in is done. When it is, the token is kept.
    public func plexCheck(flowId: String) async throws(MarqueeError) -> PlexPinCheck {
        let result: PlexPinCheck = try await send("POST", "/api/auth/plex/check", body: PlexCheckBody(flowId: flowId), signedIn: false)
        if case .ok(_, let token) = result {
            guard let token else { throw .tooOld }
            tokens.write(token)
        }
        return result
    }

    /// Signs this phone out of Marquee and forgets the token.
    public func signOut() async {
        _ = try? await request("POST", "/api/auth/logout", body: Data("{}".utf8), as: Ack.self, signedIn: false)
        tokens.write(nil)
    }

    public func forgetToken() { tokens.write(nil) }
    public var hasToken: Bool { tokens.read() != nil }
    var currentToken: String? { tokens.read() }
    var streamSession: URLSession { session }

    private struct Ack: Decodable, Sendable {}

    private func keep(_ answer: MaybeToken) throws(MarqueeError) -> SessionUser {
        guard let token = answer.token else { throw .tooOld }
        tokens.write(token)
        return answer.user
    }

    private func send<T: Decodable & Sendable>(_ method: String, _ path: String, body: some Encodable & Sendable, signedIn: Bool) async throws(MarqueeError) -> T {
        let data: Data
        do { data = try JSONEncoder().encode(body) } catch { throw .decoding("\(error)") }
        return try await request(method, path, body: data, as: T.self, signedIn: signedIn)
    }

    // MARK: The request itself

    private func request<T: Decodable & Sendable>(
        _ method: String,
        _ path: String,
        body: Data?,
        as type: T.Type,
        only: URL? = nil,
        signedIn: Bool = true
    ) async throws(MarqueeError) -> T {
        var tries: [URL]
        if let only {
            tries = [only]
        } else if onOutside {
            tries = [addresses.outside ?? addresses.home]
        } else {
            tries = [addresses.home] + (addresses.outside.map { [$0] } ?? [])
        }

        var lastUnreachable = tries[0]
        lastFailureWasConnecting = true
        for (index, base) in tries.enumerated() {
            let isHomeWithFallback = index == 0 && tries.count > 1
            do {
                let result = try await attempt(base, method, path, body, type, signedIn: signedIn, timeout: isHomeWithFallback ? 10 : 20)
                if only == nil { onOutside = base != addresses.home }
                return result
            } catch let error as MarqueeError {
                if case .unreachable(let url) = error {
                    lastUnreachable = url
                    // A write that may have gone through (it timed out, or the line dropped) is never sent again elsewhere.
                    if method != "GET" && !lastFailureWasConnecting { throw error }
                    continue
                }
                throw error
            } catch is CancellationError {
                throw .cancelled
            } catch {
                throw .decoding("\(error)")
            }
        }
        throw .unreachable(only == nil ? addresses.home : lastUnreachable)
    }

    private func attempt<T: Decodable & Sendable>(
        _ base: URL,
        _ method: String,
        _ path: String,
        _ body: Data?,
        _ type: T.Type,
        signedIn: Bool,
        timeout: TimeInterval
    ) async throws -> T {
        guard let url = URL(string: base.absoluteString + path) else { throw MarqueeError.decoding("bad address \(path)") }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token = tokens.read() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            let code = (error as? URLError)?.code
            lastFailureWasConnecting = code == .cannotConnectToHost || code == .cannotFindHost || code == .notConnectedToInternet || code == .dnsLookupFailed
            throw MarqueeError.unreachable(base)
        }
        guard let http = response as? HTTPURLResponse else { throw MarqueeError.unreachable(base) }

        let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        if contentType.contains("text/html") { throw MarqueeError.pangolinInTheWay }

        if (200..<300).contains(http.statusCode) {
            do { return try decoder.decode(T.self, from: data.isEmpty ? Data("{}".utf8) : data) } catch { throw MarqueeError.decoding("\(error)") }
        }
        if http.statusCode == 401 && signedIn {
            tokens.write(nil)
            throw MarqueeError.signedOut
        }
        if let apiError = try? decoder.decode(ApiError.self, from: data) {
            throw MarqueeError.server(code: apiError.error, message: apiError.message)
        }
        throw MarqueeError.server(code: "http_\(http.statusCode)", message: "Marquee answered with an error (\(http.statusCode)).")
    }
}
