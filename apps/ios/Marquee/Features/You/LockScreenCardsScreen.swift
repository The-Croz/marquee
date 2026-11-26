import ActivityKit
import MarqueeKit
import SwiftUI

/// Live Activities Marquee may start by itself on this iPhone: one switch for each kind.
struct LockScreenCardsScreen: View {
    @Environment(AppModel.self) private var app
    @State private var loader = Loader<LiveSettings>()
    @State private var settings: LiveSettings?
    @State private var deviceID: String?
    @State private var problem: String?

    private struct Change: Encodable, Sendable {
        var downloads: Bool?
        var watching: Bool?
    }

    var body: some View {
        LoadedView(loader: loader, retry: { Task { await load() } }) { loaded in
            let shown = settings ?? loaded
            List {
                if !ActivityAuthorizationInfo().areActivitiesEnabled {
                    Text("Live Activities are off for Marquee. Turn them on in iOS Settings → Marquee, then come back.").font(.footnote).foregroundStyle(.warn).listRowBackground(Color.panel)
                }
                Section {
                    row("When a download starts", "Up to three at a time, with how far along each is.", id: "live-downloads", value: shown.downloads ?? false) { Change(downloads: $0) }
                    row("When someone starts watching", "Who, what, how far in, and whether it's being converted.", id: "live-watching", value: shown.watching ?? false) { Change(watching: $0) }
                } header: {
                    Text("Start by themselves").font(.footnote.weight(.semibold)).foregroundStyle(.muted).textCase(nil)
                } footer: {
                    Text("You can also follow one download yourself: swipe it in Downloads and choose Follow on Lock Screen. Cards Marquee starts need the Apple key, under Settings → iPhone app on the web.")
                        .font(.footnote).foregroundStyle(.muted)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .background(.ink)
        .navigationTitle("Lock Screen cards")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task { await load() }
        .problemAlert($problem)
    }

    private func row(_ title: String, _ detail: String, id: String, value: Bool, change: @escaping (Bool) -> Change) -> some View {
        Toggle(isOn: Binding(get: { value }, set: { on in Task { await save(change(on)) } })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(.textPrimary)
                Text(detail).font(.caption).foregroundStyle(.muted)
            }
        }
        .tint(.amber)
        .accessibilityIdentifier(id)
        .listRowBackground(Color.panel)
    }

    private func load() async {
        await loader.run(app) { () async throws(MarqueeError) -> LiveSettings in
            let list: DevicesResponse = try await app.client.get("/api/me/devices")
            guard let id = list.devices.first(where: \.current)?.id else { throw .signedOut }
            deviceID = id
            let answer: LiveSettings = try await app.client.get("/api/me/devices/\(id)/live")
            settings = answer
            return answer
        }
        await LiveActivityController.shared.sendStartTokens(app)
    }

    /// The switch moves at once; if Marquee can't be told, it moves back and says why.
    private func save(_ change: Change) async {
        guard let id = deviceID, let before = settings else { return }
        settings = LiveSettings(downloads: change.downloads ?? before.downloads, watching: change.watching ?? before.watching)
        do {
            let _: LiveSettings = try await app.client.send("PUT", "/api/me/devices/\(id)/live", body: change)
        } catch {
            settings = before
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}
