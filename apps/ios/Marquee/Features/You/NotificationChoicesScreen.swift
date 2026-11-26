import MarqueeKit
import SwiftUI

/// Which messages this iPhone gets: one switch each, saved as soon as it's flipped.
struct NotificationChoicesScreen: View {
    @Environment(AppModel.self) private var app
    @State private var loader = Loader<DevicePushEvents>()
    @State private var choices: DevicePushEvents?
    @State private var deviceID: String?
    @State private var problem: String?

    var body: some View {
        LoadedView(loader: loader, retry: { Task { await load() } }) { loaded in
            let shown = choices ?? loaded
            List {
                ForEach(shown.sections) { section in
                    Section {
                        ForEach(section.events) { event in
                            Toggle(isOn: Binding(
                                get: { (choices ?? loaded).on.contains(event.key) },
                                set: { on in Task { await change(event.key, on: on) } }
                            )) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(event.label).foregroundStyle(.textPrimary)
                                    Text(event.description).font(.caption).foregroundStyle(.muted)
                                }
                            }
                            .tint(.amber)
                            .accessibilityIdentifier("notify-\(event.key)")
                            .listRowBackground(Color.panel)
                        }
                    } header: {
                        Text(section.name).font(.footnote.weight(.semibold)).foregroundStyle(.muted).textCase(nil)
                    }
                }
                Section {
                    Text("These are for this iPhone only. The web page, under Settings → Notifications, shows the same switches.")
                        .font(.footnote).foregroundStyle(.muted).listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
        .background(.ink)
        .navigationTitle("What you get")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task { await load() }
        .problemAlert($problem)
    }

    private func load() async {
        await loader.run(app) { () async throws(MarqueeError) -> DevicePushEvents in
            let list: DevicesResponse = try await app.client.get("/api/me/devices")
            guard let id = list.devices.first(where: \.current)?.id else { throw .signedOut }
            deviceID = id
            let answer: DevicePushEvents = try await app.client.get("/api/me/devices/\(id)/push/events")
            choices = answer
            return answer
        }
    }

    /// The switch moves at once. If Marquee can't be told, it moves back and says why. Only this one
    /// message is sent, so flipping several quickly never undoes another.
    private func change(_ key: String, on: Bool) async {
        guard let id = deviceID else { return }
        choices?.set(key, on: on)
        do {
            let _: DevicePushEvents = try await app.client.send("PUT", "/api/me/devices/\(id)/push/events", body: PushEventsChange(events: [key], on: on))
        } catch {
            choices?.set(key, on: !on)
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
    }
}
