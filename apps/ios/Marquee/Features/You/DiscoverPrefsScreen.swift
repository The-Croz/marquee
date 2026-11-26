import MarqueeKit
import SwiftUI

/// You → Discover: which services get a chip on Discover, and trailers. Just for you,
/// the same switches as the web's Settings → Discover.
struct DiscoverPrefsScreen: View {
    @Environment(AppModel.self) private var app
    @State private var loader = Loader<DiscoverPrefs>()
    @State private var prefs: DiscoverPrefs?
    @State private var problem: String?

    private struct PrefsBody: Encodable, Sendable { var hiddenServices: [String]; var trailers: Bool }

    var body: some View {
        LoadedView(loader: loader, forbiddenText: "", retry: { Task { await load() } }) { loaded in
            let shown = prefs ?? loaded
            List {
                Section {
                    ForEach(shown.all ?? []) { s in
                        Toggle(s.name, isOn: Binding(
                            get: { !(prefs ?? loaded).hiddenServices.contains(s.key) },
                            set: { on in
                                var next = prefs ?? loaded
                                next.hiddenServices.removeAll { $0 == s.key }
                                if !on { next.hiddenServices.append(s.key) }
                                Task { await save(next) }
                            }
                        ))
                        .tint(.amber)
                        .foregroundStyle(.textPrimary)
                    }
                } header: { SettingsHeader("Services") } footer: {
                    Text("Turn a service off to take its chip off Discover.").font(.caption)
                }
                .listRowBackground(Color.panel)
                Section {
                    Toggle(isOn: Binding(get: { (prefs ?? loaded).trailers }, set: { on in
                        var next = prefs ?? loaded
                        next.trailers = on
                        Task { await save(next) }
                    })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Play trailers on the web").foregroundStyle(.textPrimary)
                            Text("When you rest on a cover in the web app. They play from YouTube’s privacy-friendly player. On the iPhone a trailer only plays when you tap Trailer.").font(.caption).foregroundStyle(.muted)
                        }
                    }
                    .tint(.amber)
                } header: { SettingsHeader("Trailers") }
                .listRowBackground(Color.panel)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .background(.ink)
        .navigationTitle("Discover")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task { await load() }
        .problemAlert($problem)
    }

    private func load() async {
        await loader.run(app) { () async throws(MarqueeError) -> DiscoverPrefs in try await app.client.get("/api/discover/prefs") }
    }

    private func save(_ next: DiscoverPrefs) async {
        let before = prefs
        prefs = next
        do {
            let saved: DiscoverPrefs = try await app.client.send("PUT", "/api/discover/prefs", body: PrefsBody(hiddenServices: next.hiddenServices, trailers: next.trailers))
            prefs = DiscoverPrefs(hiddenServices: saved.hiddenServices, trailers: saved.trailers, all: next.all)
        } catch {
            prefs = before
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}
