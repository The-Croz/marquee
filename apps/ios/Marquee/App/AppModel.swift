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

    static let shared = AppModel()

    private(set) var phase: Phase = .launching
    private(set) var user: SessionUser?
    private(set) var version: String?
    private(set) var providers: AuthStatus.Providers?
    /// The addresses saved on this phone, nil before the first connect.
    private(set) var savedAddresses: ServerAddresses?
    /// Shown on the sign-in screen after something signed the phone out.
    var notice: String?
    var showingYou = false
    /// A link that arrived before sign-in finished (the app was opened by a notification).
    var pendingLink: DeepLink?
    /// A request to turn down, opened from a notification's button.
    var turnDownRequest: RequestView?
    var selectedTab: MainTab = .home
    /// The numbers on the tabs: streams playing (Home), requests waiting, downloads on their way.
    private(set) var counts = TabCounts()
    /// What's open on top of each tab, so a link can open a title from anywhere.
    var homePath = NavigationPath()
    var discoverPath = NavigationPath()
    var libraryPath = NavigationPath()
    var requestsPath = NavigationPath()
    var downloadsPath = NavigationPath()
    var searchPath = NavigationPath()

    /// Opens a movie or show on the tab the person is on.
    func open(_ route: TitleRoute) {
        switch selectedTab {
        case .home: homePath.append(route)
        case .discover: discoverPath.append(route)
        case .library: libraryPath.append(route)
        case .requests: requestsPath.append(route)
        case .downloads: downloadsPath.append(route)
        }
    }

    func open(_ link: DeepLink) {
        switch link {
        case .title(let route): open(route)
        case .requests, .downloads:
            // Someone without that tab lands on Home.
            let wanted: MainTab = link == .requests ? .requests : .downloads
            selectedTab = MainTab.tabs(for: user?.role ?? .kid).contains(wanted) ? wanted : .home
        }
    }

    /// Reads the numbers for the tabs. Admins only; a failure leaves the last numbers.
    func loadCounts() async {
        guard user?.role == .admin else {
            counts = TabCounts()
            return
        }
        if let a: ActivityCount = try? await client.get("/api/activity/count") { counts.playing = a.playing }
        if let r: RequestsSummary = try? await client.get("/api/requests/summary") { counts.requests = r.pending }
        if let d: DownloadsSummary = try? await client.get("/api/downloads/summary") { counts.downloads = d.active }
    }

    /// Asking for something: the three-second take-back window lives here so it survives closing a sheet.
    private(set) var asker: AskCoordinator!
    /// What each card turned into once asked, and the words to say about it.
    private(set) var asked: [String: RequestView] = [:]
    var askMessage: String?
    var askProblem: String?

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
        asker = AskCoordinator { [weak self] ask in await self?.sendAsk(ask) }
    }

    private struct AskBody: Encodable, Sendable {
        var kind: String
        var tmdbId: Int
        var seasons: [Int]?
    }

    private func sendAsk(_ ask: AskCoordinator.Ask) async {
        do {
            let r: RequestView = try await client.send("POST", "/api/requests", body: AskBody(kind: ask.kind, tmdbId: ask.tmdbId, seasons: ask.seasons))
            asked[ask.cardId] = r
            askMessage = r.stateText
        } catch {
            if case .signedOut = error { handle(error); return }
            askProblem = error.fullText
        }
    }

    /// The face of the app on launch: signed in if the saved token still works.
    func start() async {
        #if DEBUG
        // For checking screens by hand against demo mode: --demo-sign-in=josh (or mia, kiddo).
        if let arg = CommandLine.arguments.first(where: { $0.hasPrefix("--demo-sign-in=") }) {
            let name = String(arg.dropFirst("--demo-sign-in=".count))
            try? await connect(home: "localhost:9797", outside: "")
            if let user = try? await client.signIn(username: name, password: name == "josh" ? "correct horse battery" : "\(name) password", device: .current) { signedIn(user) }
            return
        }
        #endif
        guard phase == .launching else { return }
        do {
            let me: MeResponse = try await client.get("/api/me")
            user = me.user
            phase = .signedIn
            if let link = pendingLink {
                pendingLink = nil
                open(link)
            }
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
        if let link = pendingLink {
            pendingLink = nil
            open(link)
        }
    }

    func retryLaunch() async {
        phase = .launching
        await start()
    }

    /// Turn down was pressed on a notification: find the request and open its reason sheet.
    func showTurnDown(requestId: Int) async {
        guard let all: RequestsResponse = try? await client.get("/api/requests?scope=all") else { return }
        turnDownRequest = all.items.first { $0.id == requestId && $0.state == .pending }
    }

    struct DeclineBody: Encodable, Sendable { var reason: String }

    func turnDown(_ r: RequestView, reason: String) async {
        do {
            let _: RequestView = try await client.send("POST", "/api/requests/\(r.id)/decline", body: DeclineBody(reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)))
        } catch {
            handle(error)
        }
    }

    func changeServer() {
        phase = .needsAddress
    }

    private func forgetAsks() {
        asker.undo()
        asked = [:]
        askMessage = nil
        askProblem = nil
    }

    func signOut() async {
        forgetAsks()
        await client.signOut()
        user = nil
        showingYou = false
        phase = .signedOut
    }

    /// Every screen passes its failures here: a signed-out answer sends the phone back to sign-in.
    func handle(_ error: MarqueeError) {
        if case .signedOut = error {
            forgetAsks()
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

/// The numbers shown on the tabs.
struct TabCounts: Equatable {
    var playing = 0
    var requests = 0
    var downloads = 0
}
