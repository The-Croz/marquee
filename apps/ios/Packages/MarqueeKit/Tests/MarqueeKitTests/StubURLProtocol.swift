import Foundation
import Synchronization

/// Answers requests from a closure per host, so tests never touch a network.
/// Each test uses its own host name, so tests can run side by side.
final class StubURLProtocol: URLProtocol {
    struct Reply {
        var status = 200
        var contentType = "application/json"
        var body = Data()
    }

    typealias Handler = @Sendable (URLRequest) throws -> Reply
    private static let handlers = Mutex<[String: Handler]>([:])
    private static let seen = Mutex<[String: [URLRequest]]>([:])

    static func answer(host: String, _ handler: @escaping Handler) {
        handlers.withLock { $0[host] = handler }
        seen.withLock { $0[host] = [] }
    }

    static func requests(host: String) -> [URLRequest] { seen.withLock { $0[host] ?? [] } }

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host ?? ""
        Self.seen.withLock { $0[host, default: []].append(request) }
        guard let handler = Self.handlers.withLock({ $0[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        do {
            let reply = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": reply.contentType])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
