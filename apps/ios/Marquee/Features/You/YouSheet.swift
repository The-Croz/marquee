import MarqueeKit
import SwiftUI

/// The sheet behind the avatar: who's signed in, which server, and the way out.
struct YouSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var confirmSignOut = false
    @State private var address = ""

    var body: some View {
        let user = app.user
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 12) {
                    Text((user?.displayName ?? "?").prefix(1).uppercased())
                        .font(.title2.weight(.bold))
                        .foregroundStyle(.amberInk)
                        .frame(width: 54, height: 54)
                        .background(LinearGradient(colors: [.amber, Color(hex: 0xC2741C)], startPoint: .topLeading, endPoint: .bottomTrailing), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(user?.displayName ?? "").font(.title3.weight(.bold)).foregroundStyle(.textPrimary)
                        Text("\(roleName(user?.role)) · \(app.serverName)").font(.caption).foregroundStyle(.muted)
                    }
                    Spacer()
                    Button("Done") { app.showingYou = false }
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background(Color.raised, in: Capsule())
                        .foregroundStyle(.textPrimary)
                }

                group("More in the web app") {
                    row("Settings, lists, backups, logs", trailing: "Opens Safari ›") {
                        Task {
                            let base = await app.client.activeAddress
                            openURL(base)
                        }
                    }
                }

                group("This iPhone") {
                    row("Sign out", trailing: "", destructive: true) { confirmSignOut = true }
                        .accessibilityIdentifier("sign-out")
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)
        }
        .confirmationDialog("Sign out of Marquee on this iPhone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await app.signOut() } }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func roleName(_ role: Role?) -> String {
        switch role {
        case .admin: "Admin"
        case .member: "Member"
        case .kid: "Kid"
        default: "Signed in"
        }
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.footnote.weight(.semibold)).tracking(0.8).foregroundStyle(.dim).padding(.horizontal, 6)
            PanelCard { content() }
        }
    }

    private func row(_ title: String, trailing: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).foregroundStyle(destructive ? Color.warn : Color.textPrimary)
                Spacer()
                Text(trailing).font(.footnote).foregroundStyle(.muted)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
