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
    private var wantsOn = false

    func install(app: AppModel) {
        self.app = app
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let approve = UNNotificationAction(identifier: PushSupport.approveID, title: "Approve", options: [.authenticationRequired])
        let turnDown = UNNotificationAction(identifier: PushSupport.turnDownID, title: "Turn down", options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: PushSupport.requestCategory, actions: [approve, turnDown], intentIdentifiers: [])])
    }

    /// Reads where things stand: what iOS allows, and whether Marquee has this phone's token.
    func refresh() async {
        guard let app, app.phase == .signedIn else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        if settings.authorizationStatus == .denied { status = .blocked; return }
        let list: DevicesResponse? = try? await app.client.get("/api/me/devices")
        let on = list?.devices.first(where: \.current)?.push ?? false
        status = on ? .on : (status == .unavailable ? .unavailable : .off)
        if on, settings.authorizationStatus == .authorized { UIApplication.shared.registerForRemoteNotifications() }
    }

    func turnOn() async {
        problem = nil
        wantsOn = true
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else {
            status = .blocked
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
        // The token arrives in the app delegate, which calls `didRegister`.
    }

    func turnOff() async {
        wantsOn = false
        guard let app, let id = await currentDeviceID() else { return }
        struct Ok: Decodable, Sendable {}
        let _: Ok? = try? await app.client.send("DELETE", "/api/me/devices/\(id)/push", body: EmptyBody())
        status = .off
    }

    func didRegister(token data: Data) {
        token = PushSupport.hex(data)
        Task { await sendToken() }
    }

    func didFail() {
        status = .unavailable
        problem = "This build of the app can't get notifications yet. It needs the paid Apple developer account. Everything else works."
    }

    private func currentDeviceID() async -> String? {
        guard let app else { return nil }
        let list: DevicesResponse? = try? await app.client.get("/api/me/devices")
        return list?.devices.first(where: \.current)?.id
    }

    private func sendToken() async {
        guard let app, let token, let id = await currentDeviceID() else { return }
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
