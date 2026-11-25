import AuthenticationServices
import CryptoKit
import MarqueeKit
import Observation
import SwiftUI

/// The ways of signing in: password, Pocket ID, Plex, Jellyfin.
@Observable @MainActor
final class SignInModel {
    var username = ""
    var password = ""
    var busy = false
    var problem: String?
    /// While Plex's page is open, the address to show.
    var plexPage: URL?

    private let app: AppModel
    private var plexTask: Task<Void, Never>?

    init(app: AppModel) {
        self.app = app
    }

    func password(jellyfin: Bool = false) async {
        guard !busy else { return }
        busy = true
        problem = nil
        defer { busy = false }
        do {
            let user = jellyfin
                ? try await app.client.jellyfinSignIn(username: username, password: password, device: .current)
                : try await app.client.signIn(username: username, password: password, device: .current)
            password = ""
            app.signedIn(user)
        } catch {
            problem = error.fullText
        }
    }

    /// Pocket ID (or any single sign-on): a browser sheet, then a one-time code swapped for the token.
    func singleSignOn(using session: WebAuthenticationSession) async {
        guard !busy else { return }
        busy = true
        problem = nil
        defer { busy = false }
        let base = await app.client.activeAddress
        // Only this app knows the verifier, so a code caught by another app on the phone is no use to it.
        let verifier = Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        guard let url = URL(string: base.absoluteString + "/api/auth/oidc/start?app=1&challenge=\(challenge)") else { return }
        do {
            let callback = try await session.authenticate(using: url, callbackURLScheme: "marquee")
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if let code = items.first(where: { $0.name == "code" })?.value {
                app.signedIn(try await app.client.exchange(code: code, verifier: verifier, device: .current))
            } else {
                problem = Self.message(forSignInError: items.first(where: { $0.name == "error" })?.value)
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            // They closed the sheet. Nothing to say.
        } catch let error as MarqueeError {
            problem = error.fullText
        } catch {
            problem = "The sign-in didn't finish. Try again."
        }
    }

    /// Plex: open its page, then ask Marquee every 2 seconds whether it's done (up to 5 minutes).
    func plex() async {
        guard !busy else { return }
        busy = true
        problem = nil
        do {
            let start = try await app.client.plexStart(device: .current)
            plexPage = URL(string: start.authUrl)
            plexTask?.cancel()
            plexTask = Task { await poll(flowId: start.flowId) }
        } catch {
            problem = error.fullText
            busy = false
        }
    }

    func cancelPlex() {
        plexTask?.cancel()
        plexPage = nil
        busy = false
    }

    private func poll(flowId: String) async {
        defer { busy = false }
        for _ in 0..<150 {
            if Task.isCancelled { return }
            do {
                let answer = try await app.client.plexCheck(flowId: flowId)
                if Task.isCancelled {
                    // They closed the page just as it finished: don't leave the phone signed in behind their back.
                    await app.client.forgetToken()
                    return
                }
                switch answer {
                case .ok(let user, _):
                    plexPage = nil
                    app.signedIn(user)
                    return
                case .denied(let message):
                    plexPage = nil
                    problem = message
                    return
                case .expired:
                    plexPage = nil
                    problem = "That Plex sign-in took too long. Try again."
                    return
                case .pending:
                    break
                }
            } catch {
                plexPage = nil
                problem = error.fullText
                return
            }
            try? await Task.sleep(for: .seconds(2))
        }
        plexPage = nil
        problem = "That Plex sign-in took too long. Try again."
    }

    /// The plain words for the error names Marquee puts on the end of a failed browser sign-in.
    static func message(forSignInError code: String?) -> String {
        switch code {
        case "oidc_no_account": "That account isn't set up in Marquee yet. Ask an admin to add you."
        case "oidc_account_exists": "You already have a Marquee account. Sign in with your password, then link it on the web under Settings → Account."
        case "oidc_unreachable": "Marquee couldn't reach the sign-in service. Check that it's running."
        case "oidc_expired": "That sign-in took too long. Try again."
        default: "The sign-in didn't finish. Try again."
        }
    }
}
