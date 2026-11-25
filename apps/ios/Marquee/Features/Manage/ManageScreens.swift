import MarqueeKit
import SwiftUI

private struct Ok: Decodable, Sendable {}

private func tone(_ t: String) -> Tone {
    switch t {
    case "ok": .ready
    case "problem": .needsYou
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

struct ManageHub: View {
    @Environment(AppModel.self) private var app
    @State private var model = ManageModel()

    var body: some View {
        List {
            Section {
                NavigationLink { HealthScreen() } label: { row("Health", trailing: healthText, warn: (model.health.value?.problems ?? 0) > 0) }
                NavigationLink { ProfilesScreen() } label: { row("Quality profiles", trailing: "") }
                NavigationLink { SourcesScreen() } label: { row("Sources", trailing: sourcesText, warn: model.sources.value?.sources.contains { !$0.isWorking && $0.enabled } == true) }
                NavigationLink { PeopleScreen() } label: { row("People", trailing: model.users.value.map { "\($0.users.count)" } ?? "") }
                NavigationLink { LibraryCareScreen() } label: { row("Library care", trailing: careText, warn: (model.unmatched.value?.items.count ?? 0) > 0) }
            }
            .listRowBackground(Color.panel)
            Section {
                Text("Settings, lists, backups, logs, wording and automation are on the web. Open them from You → More in the web app.").font(.footnote).foregroundStyle(.muted)
            }
            .listRowBackground(Color.clear)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(.ink)
        .navigationTitle("Manage")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(app) }
        .refreshable { await model.load(app) }
    }

    private var healthText: String {
        guard let h = model.health.value else { return "" }
        return h.problems == 0 ? "All good" : "\(h.problems) \(h.problems == 1 ? "problem" : "problems")"
    }

    private var sourcesText: String {
        guard let s = model.sources.value else { return "" }
        let working = s.sources.filter(\.isWorking).count
        return "\(working) working"
    }

    private var careText: String {
        let n = model.unmatched.value?.items.count ?? 0
        return n == 0 ? "" : "Needs a match · \(n)"
    }

    private func row(_ title: String, trailing: String, warn: Bool = false) -> some View {
        HStack {
            Text(title).foregroundStyle(.textPrimary)
            Spacer()
            Text(trailing).font(.footnote).foregroundStyle(warn ? Color.warn : Color.muted)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Health

struct HealthScreen: View {
    @Environment(AppModel.self) private var app
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
                        }
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .combine)
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

    struct Enabled: Encodable, Sendable { var enabled: Bool }

    var body: some View {
        LoadedView(loader: loader, retry: { Task { await load() } }) { v in
            List {
                if v.sources.isEmpty {
                    MessageView(title: "No Sources yet.", detail: "Add one on the web, under Settings → Sources. Marquee needs at least one to find copies.").listRowBackground(Color.clear)
                }
                ForEach(v.sources) { s in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Circle().fill(s.isWorking ? Color.readyTeal : (s.enabled ? Color.warn : Color.dim)).frame(width: 10, height: 10).accessibilityHidden(true)
                            Text(s.name).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                            Spacer()
                            Toggle("On", isOn: Binding(get: { s.enabled }, set: { on in Task { await set(s, on) } })).labelsHidden().tint(.amber)
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
                Section { Text("Adding Sources and sites stays on the web, under Settings → Sources.").font(.footnote).foregroundStyle(.muted) }
                    .listRowBackground(Color.clear)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
        .background(.ink)
        .navigationTitle("Sources")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .problemAlert($problem)
        .toast(Binding(get: { message }, set: { message = $0 }))
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
                        HStack {
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
                Section { Text("Adding and removing people stays on the web, under Settings → Users.").font(.footnote).foregroundStyle(.muted) }
                    .listRowBackground(Color.clear)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
        .background(.ink)
        .navigationTitle("People")
        .navigationBarTitleDisplayMode(.inline)
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

    init(user: UserSummary, changed: @escaping () -> Void) {
        self.user = user
        self.changed = changed
        _role = State(initialValue: user.role.wire)
        _skip = State(initialValue: user.skipApproval)
        _limit = State(initialValue: user.weeklyLimit)
    }

    struct Patch: Encodable, Sendable {
        var role: String
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
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(saving).accessibilityIdentifier("save-person") }
            }
        }
        .presentationBackground(Color(hex: 0x0E1117))
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            struct Answer: Decodable, Sendable { var user: UserSummary }
            let _: Answer = try await app.client.send("PATCH", "/api/users/\(user.id)", body: Patch(role: role, skipApproval: skip, weeklyLimit: limit))
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
        .task { await loader.run(app) { () async throws(MarqueeError) -> ProfilesView in try await app.client.get("/api/settings/profiles") } }
    }

    private func load() async {
        await loader.run(app) { () async throws(MarqueeError) -> ProfilesView in try await app.client.get("/api/settings/profiles") }
    }
}

struct LibraryCareScreen: View {
    @Environment(AppModel.self) private var app
    @State private var unmatched = Loader<UnmatchedResponse>()
    @State private var leftOut = Loader<LeftOutResponse>()
    @State private var choosing: UnmatchedItem?
    @State private var problem: String?

    struct Match: Encodable, Sendable { var tmdbId: Int }

    var body: some View {
        List {
            Section {
                if let items = unmatched.value?.items {
                    if items.isEmpty { Text("Every folder has a match.").font(.subheadline).foregroundStyle(.muted) }
                    ForEach(items) { i in
                        Button { choosing = i } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(i.folder).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(2)
                                Text(i.reason ?? "Marquee couldn't tell what this is. Pick the right one.").font(.caption).foregroundStyle(.muted)
                            }
                            .frame(minHeight: 44, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .combine)
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
            } header: { head("Left out of scans") } footer: { Text("Clean-up, renaming and importing files are on the web, under Library.").font(.caption) }
            .listRowBackground(Color.panel)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(.ink)
        .navigationTitle("Library care")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $choosing) { item in MatchSheet(item: item) { Task { await load() } } }
        .problemAlert($problem)
    }

    private func load() async {
        await unmatched.run(app) { () async throws(MarqueeError) -> UnmatchedResponse in try await app.client.get("/api/library/unmatched") }
        await leftOut.run(app) { () async throws(MarqueeError) -> LeftOutResponse in try await app.client.get("/api/library/left-out") }
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
                    Button("Leave it out of Marquee") { Task { await ignore() } }.foregroundStyle(.warn)
                } footer: { Text("Marquee won't ask about this folder again. You can let it back in from Library care.").font(.caption) }
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
