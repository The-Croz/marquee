import MarqueeKit
import SwiftUI

/// You → Account: the same things as the web's Settings → Account. Your name, your password,
/// and the phones signed in to your account. Linking Plex or single sign-on stays on the web.
struct AccountScreen: View {
    @Environment(AppModel.self) private var app
    @State private var name = ""
    @State private var current = ""
    @State private var next = ""
    @State private var devices = Loader<DevicesResponse>()
    @State private var savingName = false
    @State private var savingPassword = false
    @State private var problem: String?
    @State private var message: String?
    @State private var removing: DeviceView?

    private struct NameBody: Encodable, Sendable { var displayName: String }
    private struct PasswordBody: Encodable, Sendable { var current: String?; var next: String }
    private struct Answer: Decodable, Sendable { var user: SessionUser }
    private struct Ok: Decodable, Sendable {}

    var body: some View {
        let user = app.user
        Form {
            Section {
                TextField("Your name", text: $name)
                    .textContentType(.name)
                    .submitLabel(.done)
                    .onSubmit { Task { await saveName() } }
                    .accessibilityIdentifier("display-name")
                if name.trimmingCharacters(in: .whitespaces) != (user?.displayName ?? "") {
                    Button(savingName ? "Saving…" : "Save name") { Task { await saveName() } }
                        .disabled(savingName || name.trimmingCharacters(in: .whitespaces).isEmpty)
                        .foregroundStyle(.amber)
                }
            } header: { SettingsHeader("Name") } footer: {
                Text("Username \(user?.username ?? "") · \(roleWord(user?.role))").font(.caption)
            }
            .listRowBackground(Color.panel)

            Section {
                if user?.linked.password == true {
                    SecureField("Current password", text: $current).textContentType(.password)
                }
                SecureField("New password", text: $next).textContentType(.newPassword)
                Button(savingPassword ? "Changing…" : (user?.linked.password == true ? "Change password" : "Set a password")) { Task { await savePassword() } }
                    .disabled(savingPassword || next.count < 10 || (user?.linked.password == true && current.isEmpty))
                    .foregroundStyle(.amber)
                    .accessibilityIdentifier("change-password")
            } header: { SettingsHeader("Password") } footer: {
                Text("At least 10 characters. This iPhone stays signed in; everywhere else signs in again.").font(.caption)
            }
            .listRowBackground(Color.panel)

            Section {
                SettingsRowLabel(icon: "play.rectangle.fill", tint: .amber, title: "Plex", detail: user?.linked.plex == true ? "Linked" : "Not linked", detailTone: user?.linked.plex == true ? .ready : .neutral)
                SettingsRowLabel(icon: "person.badge.key.fill", tint: .downloadBlue, title: "Single sign-on", detail: user?.linked.oidc == true ? "Linked" : "Not linked", detailTone: user?.linked.oidc == true ? .ready : .neutral)
                WebSettingsRow(icon: "link", title: "Link or unlink on the web", path: "/settings/account")
            } header: { SettingsHeader("Other ways to sign in") }
            .listRowBackground(Color.panel)

            Section {
                if let list = devices.value?.devices {
                    if list.isEmpty { Text("No phones yet.").foregroundStyle(.muted) }
                    ForEach(list) { d in deviceRow(d) }
                } else if devices.loading {
                    Skeleton(height: 44)
                } else if let p = devices.problem {
                    Text(p.title).foregroundStyle(.warn)
                }
            } header: { SettingsHeader("Your phones") } footer: {
                Text("Remove a phone you've lost or sold: it's signed out and gets no more notifications.").font(.caption)
            }
            .listRowBackground(Color.panel)
        }
        .scrollContentBackground(.hidden)
        .background(.ink)
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .onAppear { if name.isEmpty { name = user?.displayName ?? "" } }
        .task { await loadDevices() }
        .problemAlert($problem)
        .toast($message)
        .confirmationDialog("Remove \(removing?.name ?? "this phone")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { d in
            Button("Remove it", role: .destructive) { Task { await remove(d) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("It's signed out of Marquee and stops getting notifications.") }
    }

    private func deviceRow(_ d: DeviceView) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "iphone").foregroundStyle(.soft).frame(width: 30).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(d.name + (d.current ? " · this iPhone" : "")).foregroundStyle(.textPrimary)
                Text([d.signedIn ? "Signed in" : "Signed out", d.push == true ? "notifications on" : nil, "seen \(Format.ago(d.lastSeenAt))"].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.muted)
            }
            Spacer()
            if !d.current {
                Button("Remove") { removing = d }.font(.footnote.weight(.semibold)).foregroundStyle(.warn).frame(minHeight: 44).buttonStyle(.plain)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func roleWord(_ r: Role?) -> String {
        switch r {
        case .admin: "Admin"
        case .member: "Member"
        case .kid: "Kid"
        default: ""
        }
    }

    private func loadDevices() async {
        await devices.run(app) { () async throws(MarqueeError) -> DevicesResponse in try await app.client.get("/api/me/devices") }
    }

    private func saveName() async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != app.user?.displayName else { return }
        savingName = true
        defer { savingName = false }
        do {
            let a: Answer = try await app.client.send("PATCH", "/api/me", body: NameBody(displayName: trimmed))
            app.updated(a.user)
            message = "Name saved."
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }

    private func savePassword() async {
        savingPassword = true
        defer { savingPassword = false }
        do {
            let a: Answer = try await app.client.send("POST", "/api/me/password", body: PasswordBody(current: current.isEmpty ? nil : current, next: next))
            app.updated(a.user)
            current = ""
            next = ""
            message = "Password changed. Everywhere else signs in again."
            await loadDevices()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }

    private func remove(_ d: DeviceView) async {
        do {
            let _: Ok = try await app.client.send("DELETE", "/api/me/devices/\(d.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? d.id)", body: EmptyBody())
            await loadDevices()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}
