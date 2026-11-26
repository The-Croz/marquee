import MarqueeKit
import SwiftUI

private struct Ok: Decodable, Sendable {}

private func tone(_ t: String) -> Tone {
    switch t {
    case "ok": .ready
    case "problem", "attention": .needsYou
    case "busy": .downloading
    default: .neutral
    }
}

private func dot(_ t: String) -> some View {
    Circle().fill(tone(t).color).frame(width: 10, height: 10).accessibilityHidden(true)
}

/// A grey section title used across the Manage screens.
private func head(_ text: String) -> some View {
    Text(text).font(.footnote.weight(.semibold)).foregroundStyle(.muted).textCase(nil)
}

// MARK: Hub

@Observable @MainActor
final class ManageModel {
    let health = Loader<HealthView>()
    let sources = Loader<SourcesView>()
    let users = Loader<UsersResponse>()
    let unmatched = Loader<UnmatchedResponse>()

    func load(_ app: AppModel) async {
        await health.run(app) { () async throws(MarqueeError) -> HealthView in try await app.client.get("/api/system/health") }
        await sources.run(app) { () async throws(MarqueeError) -> SourcesView in try await app.client.get("/api/settings/sources") }
        await users.run(app) { () async throws(MarqueeError) -> UsersResponse in try await app.client.get("/api/users") }
        await unmatched.run(app) { () async throws(MarqueeError) -> UnmatchedResponse in try await app.client.get("/api/library/unmatched") }
    }
}

// MARK: Health

struct HealthScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var loader = Loader<HealthView>()
    @State private var problem: String?
    @State private var running: String?

    var body: some View {
        LoadedView(loader: loader, retry: { Task { await load() } }) { h in
            List {
                Section {
                    ForEach(h.connections) { c in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack { dot(c.tone); Text(c.name).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary); Spacer(); Text(c.state).font(.footnote).foregroundStyle(tone(c.tone).color) }
                            if let fix = c.fix { Text(fix).font(.caption).foregroundStyle(.soft).fixedSize(horizontal: false, vertical: true) }
                            if let detail = c.detail { Text("It said: \(detail)").font(.caption2).foregroundStyle(.dim).fixedSize(horizontal: false, vertical: true) }
                        }
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .combine)
                        if c.fix != nil, let to = c.to {
                            Button { Task { openURL(await app.webURL(to)) } } label: {
                                Label(c.tone == "off" ? "Set up on the web" : "Fix on the web", systemImage: "arrow.up.right")
                                    .font(.footnote.weight(.semibold)).foregroundStyle(.amber).frame(minHeight: 44)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } header: { head("Connections") }
                .listRowBackground(Color.panel)
                Section {
                    ForEach(h.disks) { d in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack { dot(d.tone); Text(d.label).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary); Spacer(); Text(d.state).font(.footnote).foregroundStyle(tone(d.tone).color) }
                            Text(d.path).font(.caption.monospaced()).foregroundStyle(.muted)
                            if let fix = d.fix { Text(fix).font(.caption).foregroundStyle(.soft).fixedSize(horizontal: false, vertical: true) }
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: { head("Folders") }
                .listRowBackground(Color.panel)
                Section {
                    ForEach(h.jobs) { j in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(j.label).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                                Spacer()
                                if j.off == nil {
                                    Button(running == j.id || j.running ? "Running…" : "Run now") { Task { await run(j) } }
                                        .font(.footnote.weight(.semibold)).foregroundStyle(.amber).frame(minHeight: 44)
                                        .disabled(running != nil || j.running)
                                }
                            }
                            Text(j.off ?? j.every).font(.caption).foregroundStyle(j.off == nil ? Color.muted : Color.dim)
                            if let m = j.lastMessage { Text(m).font(.caption).foregroundStyle(j.lastOk == false ? Color.warn : Color.soft) }
                        }
                    }
                } header: { head("Checks that run by themselves") }
                .listRowBackground(Color.panel)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
        .background(.ink)
        .navigationTitle("Health")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task { await load() }
        .problemAlert($problem)
    }

    private func load() async {
        await loader.run(app) { () async throws(MarqueeError) -> HealthView in try await app.client.get("/api/system/health") }
    }

    private func run(_ j: JobView) async {
        running = j.id
        defer { running = nil }
        do {
            let _: Ok = try await app.client.post("/api/system/jobs/\(j.id)/run")
            await load()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}

// MARK: Sources

struct SourcesScreen: View {
    @Environment(AppModel.self) private var app
    @State private var loader = Loader<SourcesView>()
    @State private var problem: String?
    @State private var checking: Int?
    @State private var message: String?
    @State private var turningOff: SourceView?

    struct Enabled: Encodable, Sendable { var enabled: Bool }

    var body: some View {
        LoadedView(loader: loader, retry: { Task { await load() } }) { v in
            List {
                if v.sources.isEmpty {
                    MessageView(title: "No Sources yet.", detail: "Marquee needs at least one to find copies. Add one, or link Prowlarr, on the web.").listRowBackground(Color.clear)
                }
                ForEach(v.sources) { s in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Circle().fill(s.isWorking ? Color.readyTeal : (s.enabled ? Color.warn : Color.dim)).frame(width: 10, height: 10).accessibilityHidden(true)
                            Text(s.name).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                            Spacer()
                            Toggle("On", isOn: Binding(get: { s.enabled }, set: { on in if on { Task { await set(s, true) } } else { turningOff = s } })).labelsHidden().tint(.amber)
                        }
                        Text(s.enabled ? s.stateLabel : "Off").font(.caption).foregroundStyle(s.isWorking ? Color.readyTeal : (s.enabled ? Color.warn : Color.muted))
                        if let m = s.stateMessage { Text(m).font(.caption).foregroundStyle(.soft).fixedSize(horizontal: false, vertical: true) }
                        if let fix = s.fix { Text(fix).font(.caption).foregroundStyle(.soft).fixedSize(horizontal: false, vertical: true) }
                        Button(checking == s.id ? "Checking…" : "Check now") { Task { await check(s) } }
                            .font(.footnote.weight(.semibold)).foregroundStyle(.amber).frame(minHeight: 44).disabled(checking != nil)
                    }
                    .padding(.vertical, 2)
                    .listRowBackground(Color.panel)
                }
                Section {
                    WebSettingsRow(icon: "plus", tint: .amber, title: "Add a Source or link Prowlarr", path: "/settings/sources")
                } footer: { Text("Adding Sources and sites, and their limits, stay on the web.").font(.caption) }
                .listRowBackground(Color.panel)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
        .background(.ink)
        .navigationTitle("Sources")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task { await load() }
        .problemAlert($problem)
        .toast(Binding(get: { message }, set: { message = $0 }))
        .confirmationDialog("Turn off \(turningOff?.name ?? "this Source")?", isPresented: Binding(get: { turningOff != nil }, set: { if !$0 { turningOff = nil } }), titleVisibility: .visible, presenting: turningOff) { s in
            Button("Turn it off", role: .destructive) { Task { await set(s, false) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Marquee stops looking there until you turn it back on.")
        }
    }

    private func load() async {
        await loader.run(app) { () async throws(MarqueeError) -> SourcesView in try await app.client.get("/api/settings/sources") }
    }

    private func set(_ s: SourceView, _ on: Bool) async {
        do {
            let _: Ok = try await app.client.send("PUT", "/api/settings/sources/\(s.id)", body: Enabled(enabled: on))
            await load()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }

    private func check(_ s: SourceView) async {
        checking = s.id
        defer { checking = nil }
        do {
            let _: Ok = try await app.client.post("/api/settings/sources/\(s.id)/check")
            message = "Checked \(s.name)."
            await load()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}

// MARK: People

struct PeopleScreen: View {
    @Environment(AppModel.self) private var app
    @State private var loader = Loader<UsersResponse>()
    @State private var editing: UserSummary?

    var body: some View {
        LoadedView(loader: loader, retry: { Task { await load() } }) { v in
            List {
                ForEach(v.users) { u in
                    Button { editing = u } label: {
                        HStack(spacing: 12) {
                            Face(name: u.displayName, path: u.avatar, size: 32)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(u.displayName).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                                Text("\(roleName(u.role))\(u.skipApproval ? " · requests skip approval" : "")\(u.lastLoginAt.map { " · signed in \(Format.ago($0))" } ?? "")").font(.caption).foregroundStyle(.muted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.dim)
                        }
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.panel)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("person-\(u.username)")
                }
                Section {
                    WebSettingsRow(icon: "person.badge.plus", tint: .amber, title: "Add or remove people", path: "/settings/users")
                } footer: { Text("Tap someone to change their role or whether their requests skip approval.").font(.caption) }
                .listRowBackground(Color.panel)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
        .background(.ink)
        .navigationTitle("People")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task { await load() }
        .sheet(item: $editing) { u in PersonSheet(user: u) { Task { await load() } } }
    }

    private func load() async {
        await loader.run(app) { () async throws(MarqueeError) -> UsersResponse in try await app.client.get("/api/users") }
    }
}

private func roleName(_ r: Role) -> String {
    switch r {
    case .admin: "Admin"
    case .member: "Member"
    case .kid: "Kid"
    case .unknown(let t): t.capitalized
    }
}

struct PersonSheet: View {
    let user: UserSummary
    let changed: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var role: String
    @State private var skip: Bool
    @State private var limit: Int
    @State private var problem: String?
    @State private var saving = false
    @State private var confirmRole = false

    init(user: UserSummary, changed: @escaping () -> Void) {
        self.user = user
        self.changed = changed
        _role = State(initialValue: user.role.wire)
        _skip = State(initialValue: user.skipApproval)
        _limit = State(initialValue: user.weeklyLimit)
    }

    struct Patch: Encodable, Sendable {
        /// Left out unless it changed: any role in the request signs that person out everywhere.
        var role: String?
        var skipApproval: Bool
        var weeklyLimit: Int
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Role", selection: $role) {
                        Text("Admin").tag("admin")
                        Text("Member").tag("member")
                        Text("Kid").tag("kid")
                    }
                    .accessibilityIdentifier("role-picker")
                } footer: {
                    Text("Admins run Marquee. Members can ask for things. Kids see only kids' titles. Changing a role signs that person out everywhere.").font(.caption)
                }
                Section {
                    Toggle("Requests skip approval", isOn: $skip).tint(.amber)
                    Stepper(limit == 0 ? "No weekly limit" : "At most \(limit) requests a week", value: $limit, in: 0...100)
                } footer: {
                    Text(role == "kid" ? "For kids, only titles made for kids skip approval." : "When it's on, what they ask for goes straight through.").font(.caption)
                }
                if let problem { Section { Text(problem).font(.footnote).foregroundStyle(.warn) } }
            }
            .scrollContentBackground(.hidden)
            .background(.ink)
            .navigationTitle(user.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { if role != user.role.wire { confirmRole = true } else { Task { await save() } } }.disabled(saving).accessibilityIdentifier("save-person") }
            }
        }
        .presentationBackground(Color(hex: 0x0E1117))
        .confirmationDialog("Change \(user.displayName)'s role?", isPresented: $confirmRole, titleVisibility: .visible) {
            Button("Change role and sign them out") { Task { await save() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(user.displayName) is signed out of every device and signs back in as \(role == "kid" ? "a kid" : role == "admin" ? "an admin" : "a member").")
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            struct Answer: Decodable, Sendable { var user: UserSummary }
            let _: Answer = try await app.client.send("PATCH", "/api/users/\(user.id)", body: Patch(role: role == user.role.wire ? nil : role, skipApproval: skip, weeklyLimit: limit))
            changed()
            dismiss()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}

// MARK: Quality profiles and library care

struct ProfilesScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var loader = Loader<ProfilesView>()

    var body: some View {
        LoadedView(loader: loader, retry: { Task { await load() } }) { v in
            List {
                ForEach(v.profiles) { p in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(p.name).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                        Text("\(p.kind == "movie" ? "Movies" : "Shows") · used by \(p.titles) \(p.titles == 1 ? "title" : "titles")").font(.caption).foregroundStyle(.muted)
                        Text(p.description).font(.caption).foregroundStyle(.soft).fixedSize(horizontal: false, vertical: true)
                    }
                    .listRowBackground(Color.panel)
                    .accessibilityElement(children: .combine)
                }
                Section {
                    Button("Edit profiles on the web") {
                        Task { let base = await app.client.activeAddress; if let u = URL(string: base.absoluteString + "/settings/quality") { openURL(u) } }
                    }
                    .foregroundStyle(.amber)
                } footer: { Text("Change one title's profile from its page.").font(.caption) }
                .listRowBackground(Color.panel)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .background(.ink)
        .navigationTitle("Quality profiles")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task { await loader.run(app) { () async throws(MarqueeError) -> ProfilesView in try await app.client.get("/api/settings/profiles") } }
    }

    private func load() async {
        await loader.run(app) { () async throws(MarqueeError) -> ProfilesView in try await app.client.get("/api/settings/profiles") }
    }
}

/// What a library scan is doing, from `GET /api/library/scan`.
struct ScanStatus: Decodable, Sendable {
    var running: Bool
    var finishedAt: Int64?
    var processed: Int
    var total: Int
    var matched: Int
    var error: String?
}

struct LibraryCareScreen: View {
    @Environment(AppModel.self) private var app
    @State private var unmatched = Loader<UnmatchedResponse>()
    @State private var leftOut = Loader<LeftOutResponse>()
    @State private var scan: ScanStatus?
    @State private var choosing: UnmatchedItem?
    @State private var problem: String?

    struct Match: Encodable, Sendable { var tmdbId: Int }

    var body: some View {
        List {
            Section {
                Button { Task { await startScan() } } label: {
                    HStack(spacing: 12) {
                        SettingsRowLabel(icon: "arrow.clockwise", tint: .amber, title: scan?.running == true ? "Scanning…" : "Scan for new files", detail: scanDetail)
                        if scan?.running == true { ProgressView().tint(.amber) }
                    }
                }
                .buttonStyle(.plain)
                .disabled(scan?.running == true)
                .accessibilityIdentifier("scan-library")
            } footer: { Text("Marquee also scans by itself after each import.").font(.caption) }
            .listRowBackground(Color.panel)

            Section {
                if let items = unmatched.value?.items {
                    if items.isEmpty { Text("Every folder has a match.").font(.subheadline).foregroundStyle(.muted) }
                    ForEach(items) { i in
                        Button { choosing = i } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(i.folder).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(2)
                                    Text(i.reason ?? "Marquee couldn't tell what this is. Pick the right one.").font(.caption).foregroundStyle(.muted)
                                }
                                Spacer(minLength: 8)
                                Text("Match").font(.footnote.weight(.semibold)).foregroundStyle(.amber)
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.dim)
                            }
                            .frame(minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .combine)
                        .accessibilityHint("Pick what this folder is, or leave it out")
                    }
                } else if unmatched.loading { Skeleton(height: 44) }
            } header: { head("Needs a match") }
            .listRowBackground(Color.panel)
            Section {
                if let items = leftOut.value?.items {
                    if items.isEmpty { Text("Nothing is left out.").font(.subheadline).foregroundStyle(.muted) }
                    ForEach(items) { i in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(i.title + (i.year.map { " (\($0))" } ?? "")).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                                Text("Left out \(Format.ago(i.at))").font(.caption).foregroundStyle(.muted)
                            }
                            Spacer()
                            Button("Let it back in") { Task { await letBack(i) } }.font(.footnote.weight(.semibold)).foregroundStyle(.amber).frame(minHeight: 44)
                        }
                    }
                }
            } header: { head("Left out of scans") }
            .listRowBackground(Color.panel)
            Section {
                WebSettingsRow(icon: "sparkles", title: "Clean up: two copies, leftovers, recycle bin", path: "/library/clean-up")
                WebSettingsRow(icon: "tray.and.arrow.down", title: "Put files in your library", path: "/library/import")
                WebSettingsRow(icon: "eye.slash", title: "Not watched", path: "/library/unwatched")
            } header: { head("On the web") } footer: { Text("Renaming files to Marquee's names is on the web, under Library → More.").font(.caption) }
            .listRowBackground(Color.panel)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(.ink)
        .navigationTitle("Library care")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $choosing) { item in MatchSheet(item: item) { Task { await load() } } }
        .problemAlert($problem)
    }

    private var scanDetail: String? {
        guard let scan else { return nil }
        if scan.running { return scan.total > 0 ? "\(scan.processed) of \(scan.total)" : nil }
        if scan.error != nil { return "Last scan failed" }
        return scan.finishedAt.map { "Last \(Format.ago($0))" }
    }

    private func load() async {
        await unmatched.run(app) { () async throws(MarqueeError) -> UnmatchedResponse in try await app.client.get("/api/library/unmatched") }
        await leftOut.run(app) { () async throws(MarqueeError) -> LeftOutResponse in try await app.client.get("/api/library/left-out") }
        scan = try? await app.client.get("/api/library/scan")
    }

    private func startScan() async {
        do {
            let _: Ok = try await app.client.send("POST", "/api/library/scan", body: EmptyBody())
            // Follow it until it's done (a few seconds to a few minutes), then show what it found.
            for _ in 0..<600 {
                scan = try? await app.client.get("/api/library/scan")
                if scan?.running != true { break }
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return }
            }
            await load()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }

    private func letBack(_ i: LeftOutItem) async {
        do {
            let _: Ok = try await app.client.send("DELETE", "/api/library/left-out/\(i.id)", body: EmptyBody())
            await load()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}

struct MatchSheet: View {
    let item: UnmatchedItem
    let done: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var problem: String?
    @State private var confirmIgnore = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(item.candidates) { c in
                        Button { Task { await match(c) } } label: {
                            HStack(spacing: 12) {
                                PosterView(path: c.posterPath, color: nil, title: c.title, size: .w185).frame(width: 40)
                                Text(c.title + (c.year.map { " (\($0))" } ?? "")).foregroundStyle(.textPrimary)
                            }
                            .frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)
                    }
                    if item.candidates.isEmpty { Text("Marquee has no guesses for this one. Match it on the web, under Library → Needs a match.").font(.footnote).foregroundStyle(.muted) }
                } header: { head("Which one is “\(item.folder)”?") }
                .listRowBackground(Color.panel)
                Section {
                    Button("Leave it out of Marquee") { confirmIgnore = true }.foregroundStyle(.warn)
                } footer: { Text("Marquee won't ask about this folder again. To bring it back, use Library → Needs a match on the web.").font(.caption) }
                .listRowBackground(Color.panel)
                if let problem { Text(problem).font(.footnote).foregroundStyle(.warn).listRowBackground(Color.clear) }
            }
            .scrollContentBackground(.hidden)
            .background(.ink)
            .navigationTitle("Needs a match")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationBackground(Color(hex: 0x0E1117))
        .confirmationDialog("Leave “\(item.folder)” out?", isPresented: $confirmIgnore, titleVisibility: .visible) {
            Button("Leave it out", role: .destructive) { Task { await ignore() } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Marquee won't match it or ask about it again.") }
    }

    private func match(_ c: UnmatchedItem.Candidate) async {
        do {
            let _: Ok = try await app.client.send("POST", "/api/library/unmatched/\(item.id)/match", body: LibraryCareScreen.Match(tmdbId: c.tmdbId))
            done()
            dismiss()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }

    private func ignore() async {
        do {
            let _: Ok = try await app.client.post("/api/library/unmatched/\(item.id)/ignore")
            done()
            dismiss()
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}
