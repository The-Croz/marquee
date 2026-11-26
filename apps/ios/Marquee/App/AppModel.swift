import MarqueeKit
import Observation
import SwiftUI
import UIKit

extension AppDeviceInput {
    /// This phone, as Marquee lists it under Your phones.
    @MainActor static var current: AppDeviceInput {
        AppDeviceInput(id: UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString, name: UIDevice.current.name)
    }
}

/// Where the app is: starting, needs an address, needs sign-in, or signed in.
@Observable @MainActor
final class AppModel {
    enum Phase: Equatable { case launching, needsAddress, signedOut, signedIn, cantReach(MarqueeError) }

    private(set) var phase: Phase = .launching
    private(set) var user: SessionUser?
    private(set) var version: String?
    private(set) var providers: AuthStatus.Providers?
    /// The addresses saved on this phone, nil before the first connect.
    private(set) var savedAddresses: ServerAddresses?
    /// Shown on the sign-in screen after something signed the phone out.
    var notice: String?
    var showingYou = false
    /// Which Activity section to open (set by Home's tiles).
    var activitySection: ActivitySection = .downloads
    var selectedTab: AppTab = .home

    let client: APIClient
    private let tokens: TokenStore
    private let store = AddressStore()

    init(tokens: TokenStore = KeychainTokenStore(), session: URLSession = .shared) {
        self.tokens = tokens
        // The UI smoke test starts from a phone that has never seen Marquee.
        if CommandLine.arguments.contains("--reset-for-ui-tests") {
            AddressStore().save(nil)
            tokens.write(nil)
        }
        let addresses = AddressStore().load()
        savedAddresses = addresses
        client = APIClient(addresses: addresses ?? ServerAddresses(home: URL(string: "http://localhost:9797")!), tokens: tokens, session: session)
        if addresses == nil { phase = .needsAddress }
    }

    /// The face of the app on launch: signed in if the saved token still works.
    func start() async {
        guard phase == .launching else { return }
        do {
            let me: MeResponse = try await client.get("/api/me")
            user = me.user
            phase = .signedIn
        } catch {
            if case .signedOut = error {
                phase = .signedOut
                await loadSignInOptions()
            } else if await client.hasToken {
                // We can't tell who this is until Marquee answers, so say so instead of guessing.
                phase = .cantReach(error)
            } else {
                phase = .signedOut
                await loadSignInOptions()
            }
        }
    }

    /// "192.168.1.20:9797" for the Server line.
    var serverName: String { savedAddresses.map { ServerAddress.display($0.home) } ?? "" }

    /// Checks an address and, if Marquee answers there, remembers it.
    func connect(home homeText: String, outside outsideText: String) async throws(MarqueeError) {
        let home: URL
        var outside: URL?
        do {
            home = try ServerAddress.normalize(homeText)
            let trimmed = outsideText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { outside = try ServerAddress.normalize(trimmed) }
        } catch {
            throw .server(code: "bad_address", message: error.message)
        }
        if let outside, outside.scheme != "https" { throw .server(code: "bad_address", message: AddressError.needsHTTPS.message) }
        let health = try await client.health(at: home)
        let addresses = ServerAddresses(home: home, outside: outside)
        store.save(addresses)
        savedAddresses = addresses
        await client.use(addresses)
        version = health.version
        notice = nil
        phase = .signedOut
        await loadSignInOptions()
    }

    func loadSignInOptions() async {
        if let status = try? await client.authStatus() {
            providers = status.providers
            version = status.version
        }
    }

    func signedIn(_ user: SessionUser) {
        self.user = user
        notice = nil
        selectedTab = .home
        phase = .signedIn
    }

    func retryLaunch() async {
        phase = .launching
        await start()
    }

    func changeServer() {
        phase = .needsAddress
    }

    func signOut() async {
        await client.signOut()
        user = nil
        showingYou = false
        phase = .signedOut
    }

    /// Every screen passes its failures here: a signed-out answer sends the phone back to sign-in.
    func handle(_ error: MarqueeError) {
        if case .signedOut = error {
            user = nil
            showingYou = false
            notice = "You were signed out. Sign in again."
            phase = .signedOut
        }
    }

    /// When the app comes back to the front: try the Home address first again.
    func becameActive() async {
        await client.backHome()
    }
}

enum AppTab: Hashable { case home, activity }
