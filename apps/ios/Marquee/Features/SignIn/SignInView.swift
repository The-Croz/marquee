import MarqueeKit
import SafariServices
import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.webAuthenticationSession) private var webSession
    @State private var model: SignInModel?
    @FocusState private var focus: Field?
    enum Field { case username, password }

    var body: some View {
        let model = model ?? SignInModel(app: app)
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Marquee").font(.titleSerif(44)).foregroundStyle(.amber).padding(.top, 60)
                Text("Sign in").font(.title2.weight(.bold)).foregroundStyle(.textPrimary)

                if let notice = app.notice {
                    Text(notice).font(.subheadline.weight(.semibold)).foregroundStyle(.warn)
                        .accessibilityIdentifier("signed-out-notice")
                }

                VStack(spacing: 10) {
                    TextField("Username", text: Bindable(model).username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                        .focused($focus, equals: .username)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                        .fieldStyle()
                        .accessibilityIdentifier("username")
                    SecureField("Password", text: Bindable(model).password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { Task { await model.password() } }
                        .fieldStyle()
                        .accessibilityIdentifier("password")
                }

                if let problem = model.problem {
                    Text(problem).font(.subheadline).foregroundStyle(.warn).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("sign-in-problem")
                }

                Button {
                    Task { await model.password() }
                } label: {
                    if model.busy { ProgressView().tint(.amberInk) } else { Text("Sign in") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(model.busy || model.username.isEmpty || model.password.isEmpty)
                .accessibilityIdentifier("sign-in")

                if let providers = app.providers {
                    VStack(spacing: 10) {
                        if providers.oidc.enabled {
                            Button("Sign in with \(providers.oidc.name ?? "single sign-on")") { Task { await model.singleSignOn(using: webSession) } }
                                .buttonStyle(QuietButtonStyle())
                        }
                        if providers.plex.enabled {
                            Button("Sign in with Plex") { Task { await model.plex() } }.buttonStyle(QuietButtonStyle())
                        }
                        if providers.jellyfin.enabled {
                            Button("Sign in with Jellyfin") { Task { await model.password(jellyfin: true) } }
                                .buttonStyle(QuietButtonStyle())
                                .disabled(model.username.isEmpty || model.password.isEmpty)
                        }
                    }
                    .disabled(model.busy)
                }

                HStack(spacing: 4) {
                    Text(serverLine).font(.footnote).foregroundStyle(.muted)
                    Button("Change") { app.changeServer() }.font(.footnote.weight(.semibold)).foregroundStyle(.amber).frame(minHeight: 44)
                        .accessibilityIdentifier("change-server")
                }
            }
            .padding(.horizontal, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(.ink)
        .sheet(isPresented: Binding(get: { model.plexPage != nil }, set: { if !$0 { model.cancelPlex() } })) {
            if let url = model.plexPage { SafariSheet(url: url).ignoresSafeArea() }
        }
        .task {
            self.model = SignInModel(app: app)
            if app.providers == nil { await app.loadSignInOptions() }
        }
    }

    private var serverLine: String {
        (app.version.map { "Marquee \($0)" } ?? "Server") + " · " + app.serverName
    }
}

/// A browser page the app can close from the outside (for Plex's sign-in).
struct SafariSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
