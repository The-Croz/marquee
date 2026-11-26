import ActivityKit
import MarqueeKit
import Observation
import SwiftUI

/// Lock Screen cards: a download on its way (followed by hand, or started by Marquee) and someone watching
/// (started by Marquee). Each card's own push address goes to Marquee, which keeps it up to date; the app also
/// updates download cards itself whenever it refreshes Downloads.
@Observable @MainActor
final class LiveActivityController {
    static let shared = LiveActivityController()

    private(set) var following: Set<Int> = []
    var message: String?
    /// Where Marquee should send "start a card", by kind, as iOS last told us.
    private var startTokens: [String: String] = [:]
    /// Cards already being listened to.
    private var listening: Set<String> = []
    private var watchingStarted = false

    private struct StartToken: Encodable, Sendable {
        var kind: String
        var token: String
        var environment: String
    }

    private struct CardToken: Encodable, Sendable {
        var ref: String
        var token: String
        var environment: String
    }

    private struct Ok: Decodable, Sendable {}

    private static var environment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }

    /// Called once as the app starts (also when iOS wakes it for a card Marquee just started).
    func watch(app: AppModel) {
        guard !watchingStarted else { return }
        watchingStarted = true
        Task {
            for await data in Activity<DownloadActivityAttributes>.pushToStartTokenUpdates {
                startTokens["download"] = PushSupport.hex(data)
                await sendStartTokens(app)
            }
        }
        Task {
            for await data in Activity<WatchingActivityAttributes>.pushToStartTokenUpdates {
                startTokens["watching"] = PushSupport.hex(data)
                await sendStartTokens(app)
            }
        }
        for activity in Activity<DownloadActivityAttributes>.activities { listen(activity, app: app) }
        for activity in Activity<WatchingActivityAttributes>.activities { listen(activity, app: app) }
        Task { for await activity in Activity<DownloadActivityAttributes>.activityUpdates { listen(activity, app: app) } }
        Task { for await activity in Activity<WatchingActivityAttributes>.activityUpdates { listen(activity, app: app) } }
    }

    /// Tells Marquee where to start cards. Sent again after signing in and when the app returns: signing out forgets them.
    func sendStartTokens(_ app: AppModel) async {
        guard !startTokens.isEmpty, await app.client.hasToken, let id = await deviceID(app) else { return }
        for (kind, token) in startTokens {
            let _: Ok? = try? await app.client.send("PUT", "/api/me/devices/\(id)/live/start-token", body: StartToken(kind: kind, token: token, environment: Self.environment))
        }
    }

    private func deviceID(_ app: AppModel) async -> String? {
        let list: DevicesResponse? = try? await app.client.get("/api/me/devices")
        return list?.devices.first(where: \.current)?.id
    }

    private func listen(_ activity: Activity<DownloadActivityAttributes>, app: AppModel) {
        guard listening.insert(activity.id).inserted else { return }
        let download = activity.attributes.downloadId
        following.insert(download)
        Task {
            for await data in activity.pushTokenUpdates {
                do {
                    let _: Ok = try await app.client.send("POST", "/api/downloads/\(download)/live-activity", body: Token(token: PushSupport.hex(data), environment: Self.environment))
                } catch {
                    message = "Started the card, but Marquee can't update it while the app is closed. Try again."
                }
            }
        }
    }

    private func listen(_ activity: Activity<WatchingActivityAttributes>, app: AppModel) {
        guard listening.insert(activity.id).inserted else { return }
        let ref = activity.attributes.ref
        Task {
            for await data in activity.pushTokenUpdates {
                let _: Ok? = try? await app.client.send("POST", "/api/activity/live-activity", body: CardToken(ref: ref, token: PushSupport.hex(data), environment: Self.environment))
            }
        }
    }

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
            message = "Lock Screen cards are off for Marquee. Turn them on in iOS Settings → Marquee."
            return
        }
        if isFollowing(d.id) { return }
        do {
            let activity = try Activity.request(
                attributes: DownloadActivityAttributes(title: d.titleName, downloadId: d.id),
                content: .init(state: state(d), staleDate: nil),
                pushType: .token
            )
            listen(activity, app: app)
            let ready: ApnsReady? = try? await app.client.get("/api/settings/notifications/apns")
            if ready?.ready != true {
                message = "Following it on the Lock Screen. Updates while the app is closed need the Apple key (Settings → iPhone app on the web)."
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
