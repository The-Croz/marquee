import MarqueeKit
import SwiftUI

/// The sheet behind the avatar: the iPhone's Settings. Its groups follow the web's Settings page
/// (You, Manage, the rest of setup, About) so the two feel like one app. Everything an admin can
/// change on the web is here, either as a screen of its own or as a row that opens that exact page.
struct YouSheet: View {
    @Environment(AppModel.self) private var app
    @State private var confirmSignOut = false
    @State private var manage = ManageModel()
    @State private var pushing = PushCenter.shared

    var body: some View {
        let user = app.user
        let admin = user?.role == .admin
        NavigationStack {
            List {
                Section { header(user) }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 4, trailing: 4))

                Section {
                    NavigationLink { AccountScreen() } label: {
                        SettingsRowLabel(icon: "person.fill", tint: .amber, title: "Account")
                    }
                    .accessibilityIdentifier("account")
                    notificationsRow
                    if pushing.status == .on {
                        NavigationLink { NotificationChoicesScreen() } label: {
                            SettingsRowLabel(icon: "list.bullet", tint: .downloadBlue, title: "Which messages")
                        }
                        .accessibilityIdentifier("notification-choices")
                    }
                    if admin {
                        NavigationLink { LockScreenCardsScreen() } label: {
                            SettingsRowLabel(icon: "lock.iphone", tint: .downloadBlue, title: "Lock Screen cards")
                        }
                        .accessibilityIdentifier("lock-screen-cards")
                    }
                    if user?.role != .kid {
                        NavigationLink { DiscoverPrefsScreen() } label: {
                            SettingsRowLabel(icon: "safari.fill", tint: .readyTeal, title: "Discover")
                        }
                    }
                } header: { SettingsHeader("You") }
                .listRowBackground(Color.panel)

                Section {
                    NavigationLink { MyRequestsScreen() } label: {
                        SettingsRowLabel(icon: "clock.arrow.circlepath", tint: .amber, title: "My requests & history")
                    }
                    NavigationLink { CalendarScreen() } label: {
                        SettingsRowLabel(icon: "calendar", tint: .readyTeal, title: "Calendar")
                    }
                } header: { SettingsHeader("Yours") }
                .listRowBackground(Color.panel)

                if admin {
                    manageSection
                    webSection
                }

                Section {
                    LabeledContent("Server", value: app.serverName)
                    LabeledContent("Version", value: versionText)
                    Button { confirmSignOut = true } label: {
                        Text("Sign out").foregroundStyle(.warn).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("sign-out")
                } header: { SettingsHeader("This iPhone") }
                .listRowBackground(Color.panel)
                .foregroundStyle(.textPrimary)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color(hex: 0x0E1117))
            .navigationTitle("You")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { app.showingYou = false }.accessibilityIdentifier("you-done")
                }
            }
            .task { if admin { await manage.load(app) } }
            .refreshable { if admin { await manage.load(app) } }
        }
        .confirmationDialog("Sign out of Marquee on this iPhone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await app.signOut() } }
            Button("Cancel", role: .cancel) {}
        }
    }

    // MARK: Pieces

    private func header(_ user: SessionUser?) -> some View {
        HStack(spacing: 14) {
            Face(name: user?.displayName ?? "?", path: user?.avatar, size: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(user?.displayName ?? "").font(.title3.weight(.bold)).foregroundStyle(.textPrimary)
                Text(roleName(user?.role)).font(.subheadline).foregroundStyle(.muted)
            }
            Spacer()
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// Health, Sources and the rest, each with how it's doing, so a problem shows before you tap.
    private var manageSection: some View {
        Section {
            NavigationLink { HealthScreen() } label: {
                SettingsRowLabel(icon: "heart.text.square.fill", tint: .warn, title: "Health", detail: healthText.0, detailTone: healthText.1)
            }
            .accessibilityIdentifier("manage-health")
            NavigationLink { SourcesScreen() } label: {
                SettingsRowLabel(icon: "antenna.radiowaves.left.and.right", tint: .downloadBlue, title: "Sources", detail: sourcesText.0, detailTone: sourcesText.1)
            }
            .accessibilityIdentifier("manage-sources")
            NavigationLink { ProfilesScreen() } label: {
                SettingsRowLabel(icon: "slider.horizontal.3", tint: .amber, title: "Quality profiles")
            }
            NavigationLink { PeopleScreen() } label: {
                SettingsRowLabel(icon: "person.2.fill", tint: .readyTeal, title: "People", detail: manage.users.value.map { "\($0.users.count)" })
            }
            .accessibilityIdentifier("manage-people")
            NavigationLink { LibraryCareScreen() } label: {
                SettingsRowLabel(icon: "wrench.and.screwdriver.fill", tint: .soft, title: "Library care", detail: careText, detailTone: careText == nil ? .neutral : .needsYou)
            }
            .accessibilityIdentifier("manage-care")
        } header: { SettingsHeader("Manage") }
        .listRowBackground(Color.panel)
    }

    /// Setup that's rarely touched stays on the web; each row opens its own page there.
    private var webSection: some View {
        Section {
            WebSettingsRow(icon: "arrow.down.circle", title: "Downloader", path: "/settings/downloader")
            WebSettingsRow(icon: "list.star", title: "Lists", path: "/settings/lists")
            WebSettingsRow(icon: "magnifyingglass", title: "Automatic searching", path: "/settings/automation")
            WebSettingsRow(icon: "server.rack", title: "Services", path: "/settings/services")
            WebSettingsRow(icon: "checkmark.circle", title: "Watched sync", path: "/settings/watched-sync")
            WebSettingsRow(icon: "text.bubble", title: "Notification wording", path: "/settings/notifications/customize")
            WebSettingsRow(icon: "iphone.gen3", title: "iPhone app and push key", path: "/settings/iphone")
            WebSettingsRow(icon: "externaldrive", title: "Backups", path: "/settings/backups")
            WebSettingsRow(icon: "doc.text", title: "Logs", path: "/settings/logs")
        } header: { SettingsHeader("On the web") } footer: {
            Text("These open the web app in Safari, at the address this iPhone is using.").font(.caption)
        }
        .listRowBackground(Color.panel)
    }

    @ViewBuilder private var notificationsRow: some View {
        let status = pushing.status
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(
                get: { status == .on },
                set: { on in Task { if on { await pushing.turnOn() } else { await pushing.turnOff() } } }
            )) {
                SettingsRowLabel(icon: "bell.badge.fill", tint: .warn, title: "Notifications")
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
        .task { await pushing.refresh() }
    }

    // MARK: Words

    private var healthText: (String?, Tone) {
        guard let h = manage.health.value else { return (nil, .neutral) }
        return h.problems == 0 ? ("All good", .ready) : ("\(h.problems) \(h.problems == 1 ? "problem" : "problems")", .needsYou)
    }

    private var sourcesText: (String?, Tone) {
        guard let s = manage.sources.value else { return (nil, .neutral) }
        if s.sources.isEmpty { return ("None yet", .needsYou) }
        let failing = s.sources.filter { $0.enabled && !$0.isWorking }.count
        if failing > 0 { return ("\(failing) not working", .needsYou) }
        return ("\(s.sources.filter(\.isWorking).count) working", .ready)
    }

    private var careText: String? {
        let n = manage.unmatched.value?.items.count ?? 0
        return n == 0 ? nil : "\(n) \(n == 1 ? "needs" : "need") a match"
    }

    private var versionText: String {
        let info = Bundle.main.infoDictionary
        let app = [info?["CFBundleShortVersionString"] as? String, (info?["CFBundleVersion"] as? String).map { "(\($0))" }].compactMap { $0 }.joined(separator: " ")
        guard let server = self.app.version else { return app }
        return "\(app) · server \(server)"
    }

    private func roleName(_ role: Role?) -> String {
        switch role {
        case .admin: "Admin"
        case .member: "Member"
        case .kid: "Kid · kids' titles only"
        default: "Signed in"
        }
    }
}
