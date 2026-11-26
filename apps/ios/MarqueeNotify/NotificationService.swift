import MarqueeKit
import UserNotifications

/// Puts the cover art on a notification. Anything that goes wrong (no picture, slow, too big) just delivers the notification as it is.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    nonisolated(unsafe) private var handler: ((UNNotificationContent) -> Void)?
    nonisolated(unsafe) private var content: UNMutableNotificationContent?
    nonisolated(unsafe) private var work: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        self.handler = contentHandler
        self.content = content
        let text = content.userInfo["image"] as? String
        work = Task { [weak self] in
            if let attachment = await Self.coverArt(text) { self?.content?.attachments = [attachment] }
            self?.deliver()
        }
    }

    /// Out of time: deliver what there is.
    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        deliver()
    }

    private func deliver() {
        guard let handler, let content else { return }
        self.handler = nil
        handler(content)
    }

    private static func coverArt(_ text: String?) async -> UNNotificationAttachment? {
        guard PushSupport.isAllowedCoverArt(text), let text, let url = URL(string: text) else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        guard let (file, response) = try? await URLSession.shared.download(for: req), (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        guard size > 0, size <= PushSupport.maxCoverArtBytes else { return nil }
        let target = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".jpg")
        guard (try? FileManager.default.moveItem(at: file, to: target)) != nil else { return nil }
        return try? UNNotificationAttachment(identifier: "cover", url: target)
    }
}
