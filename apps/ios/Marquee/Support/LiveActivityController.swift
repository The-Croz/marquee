import ActivityKit
import MarqueeKit
import Observation
import SwiftUI

/// Follow on Lock Screen: a card for a download on its way. Marquee updates it by push when the Apple key is set;
/// the app updates it itself whenever it refreshes Downloads.
@Observable @MainActor
final class LiveActivityController {
    static let shared = LiveActivityController()

    private(set) var following: Set<Int> = []
    var message: String?

    private struct Token: Encodable, Sendable {
        var token: String
        var environment: String
    }

    private struct ApnsReady: Decodable, Sendable { var ready: Bool }

    private func state(_ d: DownloadView) -> DownloadActivityAttributes.ContentState {
        .init(progress: d.progress, status: d.status.label, eta: d.eta, done: d.state == .done && !d.canImport)
    }

    func isFollowing(_ id: Int) -> Bool { following.contains(id) || Activity<DownloadActivityAttributes>.activities.contains { $0.attributes.downloadId == id } }

    func follow(_ d: DownloadView, app: AppModel) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            message = "Live Activities are off for Marquee. Turn them on in iOS Settings → Marquee."
            return
        }
        if isFollowing(d.id) { return }
        do {
            let activity = try Activity.request(
                attributes: DownloadActivityAttributes(title: d.titleName, downloadId: d.id),
                content: .init(state: state(d), staleDate: nil),
                pushType: .token
            )
            following.insert(d.id)
            let ready: ApnsReady? = try? await app.client.get("/api/settings/notifications/apns")
            if ready?.ready != true {
                message = "Following it on the Lock Screen. Updates while the app is closed need the iPhone app key (Settings → Notifications on the web)."
            }
            Task { [id = d.id] in
                for await data in activity.pushTokenUpdates {
                    #if DEBUG
                    let body = Token(token: PushSupport.hex(data), environment: "sandbox")
                    #else
                    let body = Token(token: PushSupport.hex(data), environment: "production")
                    #endif
                    struct Ok: Decodable, Sendable {}
                    let _: Ok? = try? await app.client.send("POST", "/api/downloads/\(id)/live-activity", body: body)
                }
            }
        } catch {
            message = "Couldn't start the Lock Screen card. Try again."
        }
    }

    /// Called with every refresh of Downloads: keeps the cards in step, and puts one away once it's in the library.
    func sync(_ items: [DownloadView]) async {
        for activity in Activity<DownloadActivityAttributes>.activities {
            guard let d = items.first(where: { $0.id == activity.attributes.downloadId }) else {
                await activity.end(nil, dismissalPolicy: .immediate)
                following.remove(activity.attributes.downloadId)
                continue
            }
            let s = state(d)
            if s.done || d.state == .failed || d.state == .removed {
                await activity.end(.init(state: s, staleDate: nil), dismissalPolicy: .after(.now + 300))
                following.remove(d.id)
            } else {
                await activity.update(.init(state: s, staleDate: nil))
            }
        }
    }
}
