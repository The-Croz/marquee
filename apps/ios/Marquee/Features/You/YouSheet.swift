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
        NavigationStack {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 12) {
                    Face(name: user?.displayName ?? "?", path: user?.avatar, size: 54)
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

                group("You") {
                    notificationsRow
                    Divider().overlay(Color.line)
                    if pushing.status == .on {
                        NavigationLink { NotificationChoicesScreen() } label: { linkRow("What you get") }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("notification-choices")
                        Divider().overlay(Color.line)
                    }
                    if user?.role == .admin {
                        NavigationLink { LockScreenCardsScreen() } label: { linkRow("Lock Screen cards") }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("lock-screen-cards")
                        Divider().overlay(Color.line)
                    }
                    NavigationLink { MyRequestsScreen() } label: { linkRow("My requests & history") }
                        .buttonStyle(.plain)
                    Divider().overlay(Color.line)
                    NavigationLink { CalendarScreen() } label: { linkRow("Calendar") }
                        .buttonStyle(.plain)
                }

                if user?.role == .admin {
                    group("Manage") {
                        NavigationLink { ManageHub() } label: { linkRow("Health, Sources, People and more") }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("manage")
                    }
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
        .background(Color(hex: 0x0E1117))
        .toolbar(.hidden, for: .navigationBar)
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

    @State private var pushing = PushCenter.shared

    @ViewBuilder private var notificationsRow: some View {
        let status = pushing.status
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(
                get: { status == .on },
                set: { on in Task { if on { await pushing.turnOn() } else { await pushing.turnOff() } } }
            )) {
                Text("Notifications on this iPhone").foregroundStyle(.textPrimary)
            }
            .tint(.amber)
            .disabled(status == .blocked || status == .unavailable)
            .accessibilityIdentifier("notifications-toggle")
            if status == .blocked {
                Text("They're off in iOS Settings. Turn them on there, then come back.").font(.caption).foregroundStyle(.warn)
            } else if let problem = pushing.problem {
                Text(problem).font(.caption).foregroundStyle(.warn)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 50)
        .task { await pushing.refresh() }
    }

    private func linkRow(_ title: String) -> some View {
        HStack {
            Text(title).foregroundStyle(.textPrimary)
            Spacer()
            Text("›").foregroundStyle(.muted)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 50)
        .contentShape(Rectangle())
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
