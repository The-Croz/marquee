import Foundation

/// Reads a server-sent events stream (the live "who is watching" line) one event at a time.
public struct SSEParser: Sendable {
    public struct Event: Equatable, Sendable {
        public var name: String
        public var data: String
    }

    private var name = "message"
    private var data: [String] = []

    public init() {}

    /// Feed one line (without its newline). Returns an event when a blank line ends one. Comment and ping lines with no data are skipped.
    public mutating func line(_ text: String) -> Event? {
        if text.isEmpty {
            defer { name = "message"; data = [] }
            guard !data.isEmpty else { return nil }
            return Event(name: name, data: data.joined(separator: "\n"))
        }
        if text.hasPrefix(":") { return nil }
        let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = String(parts[0])
        var value = parts.count > 1 ? String(parts[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        switch field {
        case "event": name = value
        case "data": data.append(value)
        default: break
        }
        return nil
    }
}

extension APIClient {
    /// The live list of who is watching. Ends (throws) when the stream drops; the caller falls back to asking every 15 seconds and tries again.
    public func watchStream(_ path: String, onEvent: @escaping @Sendable (SSEParser.Event) -> Void) async throws(MarqueeError) {
        let base = activeAddress
        guard let url = URL(string: base.absoluteString + path) else { throw .decoding("address") }
        var req = URLRequest(url: url, timeoutInterval: 3600)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let token = currentToken { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        do {
            let (bytes, response) = try await streamSession.bytes(for: req)
            guard let http = response as? HTTPURLResponse else { throw MarqueeError.unreachable(base) }
            if http.value(forHTTPHeaderField: "Content-Type")?.contains("text/html") == true { throw MarqueeError.pangolinInTheWay }
            if http.statusCode == 401 { forgetToken(); throw MarqueeError.signedOut }
            guard http.statusCode == 200 else { throw MarqueeError.server(code: "http_\(http.statusCode)", message: "Marquee answered with an error (\(http.statusCode)).") }
            var parser = SSEParser()
            // `bytes.lines` drops empty lines, and an empty line is what ends an event, so split the lines here.
            var buffer: [UInt8] = []
            for try await byte in bytes {
                if byte == 10 {
                    var text = String(decoding: buffer, as: UTF8.self)
                    if text.hasSuffix("\r") { text.removeLast() }
                    buffer.removeAll(keepingCapacity: true)
                    if let event = parser.line(text) { onEvent(event) }
                } else {
                    buffer.append(byte)
                }
            }
        } catch let error as MarqueeError {
            throw error
        } catch is CancellationError {
            return
        } catch {
            throw .unreachable(base)
        }
    }
}
