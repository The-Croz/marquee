import Charts
import MarqueeKit
import SwiftUI

@Observable @MainActor
final class WatchingModel {
    let now = Loader<ActivityNow>()
    let stats = Loader<ActivityStats>()
    let people = Loader<[PersonSummary]>()
    private(set) var streaming = false

    func loadNow(_ app: AppModel) async {
        await now.run(app) { () async throws(MarqueeError) -> ActivityNow in try await app.client.get("/api/activity/now") }
    }

    func loadNumbers(_ app: AppModel) async {
        await stats.run(app) { () async throws(MarqueeError) -> ActivityStats in try await app.client.get("/api/activity/stats") }
        await people.run(app) { () async throws(MarqueeError) -> [PersonSummary] in
            let answer: PeopleResponse = try await app.client.get("/api/activity/people")
            return answer.people
        }
    }

    /// The live line: the list changes the moment something starts or stops. If it drops, ask every 15 seconds and try the line again.
    func follow(_ app: AppModel) async {
        while !Task.isCancelled {
            await loadNow(app)
            streaming = true
            do {
                try await app.client.watchStream("/api/activity/live") { event in
                    guard event.name == "sessions", let data = event.data.data(using: .utf8), let value = try? JSONDecoder().decode(ActivityNow.self, from: data) else { return }
                    Task { @MainActor in self.now.set(value) }
                }
            } catch {
                if case .signedOut = error { app.handle(error); return }
            }
            streaming = false
            if Task.isCancelled { return }
            try? await Task.sleep(for: .seconds(15))
        }
    }
}

/// Activity → Watching (admin): who is playing what right now, and the last 30 days.
struct WatchingList: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = WatchingModel()

    var body: some View {
        LoadedView(loader: model.now, retry: { Task { await model.loadNow(app) } }) { now in
            List {
                Section {
                    if now.sessions.isEmpty {
                        Text("Nobody is watching right now.").font(.subheadline).foregroundStyle(.muted).listRowBackground(Color.panel)
                    }
                    ForEach(now.sessions) { s in sessionRow(s).listRowBackground(Color.panel) }
                    ForEach(now.problems, id: \.self) { p in Text(p).font(.footnote).foregroundStyle(.warn).listRowBackground(Color.panel) }
                } header: { header("Now watching" + (model.streaming ? "" : " · checking every 15 seconds")) }

                if let stats = model.stats.value {
                    Section {
                        HStack(spacing: 8) {
                            CountTile(count: stats.total, label: "plays, last \(stats.days) days", tint: .readyTeal)
                            CountTile(count: stats.last24h, label: "in the last day", tint: .downloadBlue)
                            CountTile(count: stats.users.count, label: "people", tint: .amber)
                        }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                        Chart(stats.perDay) { d in
                            BarMark(x: .value("Day", d.day), y: .value("Plays", d.plays)).foregroundStyle(Color.amber)
                        }
                        .chartXAxis(.hidden)
                        .frame(height: 120)
                        .listRowBackground(Color.panel)
                        .accessibilityLabel("Plays per day, last \(stats.days) days")
                    } header: { header("Last \(stats.days) days") }

                    if !stats.movies.isEmpty || !stats.shows.isEmpty {
                        Section {
                            ForEach((stats.movies.prefix(5) + stats.shows.prefix(5)).sorted { $0.plays > $1.plays }.prefix(6)) { m in
                                HStack { Text(m.name).foregroundStyle(.textPrimary); Spacer(); Text("\(m.plays) \(m.plays == 1 ? "play" : "plays")").font(.footnote).foregroundStyle(.muted) }
                                    .listRowBackground(Color.panel)
                                    .accessibilityElement(children: .combine)
                            }
                        } header: { header("Most watched") }
                    }
                }

                if let people = model.people.value, !people.isEmpty {
                    Section {
                        ForEach(people) { p in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.name).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                                Text("\(p.plays) plays · \(p.devices.joined(separator: ", "))" + (p.last.map { " · last \(Format.ago($0))" } ?? "")).font(.caption).foregroundStyle(.muted)
                            }
                            .listRowBackground(Color.panel)
                            .accessibilityElement(children: .combine)
                        }
                    } header: { header("People") }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable { await model.loadNow(app); await model.loadNumbers(app) }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            async let numbers: Void = model.loadNumbers(app)
            await model.follow(app)
            await numbers
        }
    }

    private func header(_ text: String) -> some View {
        Text(text).font(.title3.weight(.bold)).foregroundStyle(.textPrimary).textCase(nil)
    }

    private func sessionRow(_ s: NowPlaying) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(s.title).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(1)
                Spacer()
                Text(s.state == "paused" ? "Paused" : s.state == "buffering" ? "Buffering" : "Playing").font(.caption.weight(.semibold)).foregroundStyle(s.state == "playing" ? Color.readyTeal : Color.muted)
            }
            if let sub = s.subtitle { Text(sub).font(.caption).foregroundStyle(.muted) }
            ProgressView(value: s.progress).progressViewStyle(BarStyle(fill: .readyTeal))
            Text("\(s.user) · \(s.device) · \(s.server.capitalized)\(s.resolution.map { " · \($0)" } ?? "")").font(.caption).foregroundStyle(.soft)
            if s.transcoding { StateLine(text: "Being converted for this device" + (s.convertReason.map { ": \($0)" } ?? ""), tone: .needsYou) }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityValue("\(Int(s.progress * 100)) percent")
    }
}
