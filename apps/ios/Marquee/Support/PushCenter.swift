import MarqueeKit
import Observation
import SwiftUI
import UIKit
import UserNotifications

/// Notifications on this iPhone: asking permission, telling Marquee about this phone, and what the buttons on a notification do.
@Observable @MainActor
final class PushCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCenter()

    enum Status: Equatable {
        case unknown
        case off
        case on
        /// iOS Settings says no.
        case blocked
        /// This build can't receive push (it isn't signed for it yet).
        case unavailable
    }

    private(set) var status: Status = .unknown
    var problem: String?
    private weak var app: AppModel?
    private var token: String?
    private let choice = PushChoice()

    func install(app: AppModel) {
        self.app = app
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let approve = UNNotificationAction(identifier: PushSupport.approveID, title: "Approve", options: [.authenticationRequired])
        let turnDown = UNNotificationAction(identifier: PushSupport.turnDownID, title: "Turn down", options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: PushSupport.requestCategory, actions: [approve, turnDown], intentIdentifiers: [])])
    }

    /// The first open of the app: iOS shows its "allow notifications?" popup. Once answered, it never shows again.
    func askOnFirstOpen() async {
        guard await permission() == .notAsked else { return }
        _ = await requestPermission()
        await refresh()
    }

    /// Notifications are on unless the person switched them off here or iOS says no. Called after signing in and
    /// when the app comes back, so signing out and in again needs nothing from them.
    func refresh() async {
        guard let app, app.phase == .signedIn, let user = app.user else { return }
        switch PushSupport.plan(permission: await permission(), switchedOff: choice.isOff(userID: user.id)) {
        case .blocked:
            // iOS says no, so Marquee must stop sending here too (the person can't switch it off any more).
            status = .blocked
            await removeFromMarquee()
        case .off:
            status = .off
            await removeFromMarquee()
        case .ask:
            await requestAndRegister()
        case .register:
            let list: DevicesResponse? = try? await app.client.get("/api/me/devices")
            status = list?.devices.first(where: \.current)?.push == true ? .on : .off
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func turnOn() async {
        problem = nil
        if let user = app?.user { choice.set(off: false, userID: user.id) }
        await requestAndRegister()
    }

    func turnOff() async {
        if let user = app?.user { choice.set(off: true, userID: user.id) }
        status = .off
        await removeFromMarquee()
    }

    private func permission() async -> PushSupport.Permission {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .notDetermined: .notAsked
        case .denied: .denied
        default: .allowed
        }
    }

    private func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    private func requestAndRegister() async {
        guard await requestPermission() else {
            status = .blocked
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
        // The token arrives in the app delegate, which calls `didRegister`.
    }

    private func removeFromMarquee() async {
        guard let app, let id = await currentDeviceID() else { return }
        struct Ok: Decodable, Sendable {}
        let _: Ok? = try? await app.client.send("DELETE", "/api/me/devices/\(id)/push", body: EmptyBody())
    }

    func didRegister(token data: Data) {
        token = PushSupport.hex(data)
        Task { await sendToken() }
    }

    func didFail() {
        status = .off
        problem = "Couldn't register this iPhone. Check your connection and try again. If it keeps happening, this build may not be signed for notifications yet (that needs the paid Apple developer account)."
    }

    private func currentDeviceID() async -> String? {
        guard let app else { return nil }
        let list: DevicesResponse? = try? await app.client.get("/api/me/devices")
        return list?.devices.first(where: \.current)?.id
    }

    private func sendToken() async {
        guard let app, let token, app.phase == .signedIn, let user = app.user, !choice.isOff(userID: user.id) else { return }
        guard let id = await currentDeviceID() else {
            problem = "Couldn't reach Marquee to turn notifications on. Check your connection and try again."
            status = .off
            return
        }
        #if DEBUG
        let body = PushSupport.Registration(token: token, debug: true)
        #else
        let body = PushSupport.Registration(token: token, debug: false)
        #endif
        struct Ok: Decodable, Sendable {}
        do {
            let _: Ok = try await app.client.send("POST", "/api/me/devices/\(id)/push", body: body)
            status = .on
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }

    // MARK: Notifications arriving and being pressed

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let action = PushSupport.action(actionID: response.actionIdentifier, userInfo: response.notification.request.content.userInfo)
        await handle(action)
    }

    private func handle(_ action: PushSupport.Action) async {
        guard let app else { return }
        switch action {
        case .approve(let id): await approve(id, app: app)
        case .turnDown(let id): await app.showTurnDown(requestId: id)
        case .open(let link):
            if app.phase == .signedIn { app.open(link) } else { app.pendingLink = link }
        case .nothing: break
        }
    }

    /// Approve from the Lock Screen (the phone was unlocked to press it): the default profile, then a local note saying how it went.
    private func approve(_ id: Int, app: AppModel) async {
        do {
            let r: RequestView = try await app.client.post("/api/requests/\(id)/approve")
            await say("Approved", r.title)
        } catch {
            await say("Couldn't approve it", error.fullText + " Open Marquee to try again.")
        }
    }

    private func say(_ title: String, _ body: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.interruptionLevel = .passive
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushCenter.shared.didRegister(token: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        Task { @MainActor in PushCenter.shared.didFail() }
    }
}
