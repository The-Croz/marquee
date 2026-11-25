import MarqueeKit
import SwiftUI

/// What's coming out and what's here, by day.
struct CalendarScreen: View {
    @Environment(AppModel.self) private var app
    @State private var loader = Loader<CalendarView>()

    var body: some View {
        LoadedView(loader: loader, retry: { Task { await load() } }) { cal in
            List {
                if cal.items.isEmpty {
                    MessageView(title: "Nothing is coming up.", detail: "Episodes of Wanted shows and movies coming out show up here.").listRowBackground(Color.clear)
                }
                ForEach(days(cal), id: \.0) { day, items in
                    Section {
                        ForEach(items) { item in
                            Button { open(item) } label: { row(item) }
                                .buttonStyle(.plain)
                                .listRowBackground(Color.panel)
                        }
                    } header: {
                        Text(heading(day, today: cal.today)).font(.footnote.weight(.semibold)).foregroundStyle(day == cal.today ? Color.amberHi : Color.muted).textCase(nil)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
        .background(.ink)
        .navigationTitle("Calendar")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        let today = ISO8601DateFormatter.string(from: .now, timeZone: .current, formatOptions: [.withFullDate, .withDashSeparatorInDate])
        await loader.run(app) { () async throws(MarqueeError) -> CalendarView in try await app.client.get("/api/calendar?from=\(today)&days=28") }
    }

    private func days(_ cal: CalendarView) -> [(String, [CalendarItem])] {
        Dictionary(grouping: cal.items, by: \.airDate).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    private func heading(_ day: String, today: String) -> String {
        if day == today { return "Today" }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .gmt
        guard let date = f.date(from: day), let t = f.date(from: today) else { return day }
        let diff = Calendar(identifier: .gregorian).dateComponents([.day], from: t, to: date).day ?? 0
        if diff == 1 { return "Tomorrow" }
        if diff == -1 { return "Yesterday" }
        let out = DateFormatter()
        out.dateFormat = "EEEE, MMM d"
        out.timeZone = .gmt
        return out.string(from: date)
    }

    private func open(_ item: CalendarItem) {
        let route: TitleRoute? = item.seriesId.map { TitleRoute(kind: .show, id: $0) } ?? item.movieId.map { TitleRoute(kind: .movie, id: $0) }
        guard let route else { return }
        // This screen is inside the You sheet: close it first, then open the title.
        app.showingYou = false
        app.open(route)
    }

    private func row(_ item: CalendarItem) -> some View {
        let (label, tone) = Self.state(item.state)
        return HStack(spacing: 12) {
            PosterView(path: item.posterPath, color: nil, title: item.show, size: .w185).frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.kind == "episode" ? "\(item.show) · S\(item.season) E\(item.episode)" : item.show).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(1)
                if let title = item.title, !title.isEmpty { Text(title).font(.caption).foregroundStyle(.muted).lineLimit(1) }
                StateLine(text: item.state == "not_watched" ? item.note : "\(label) · \(item.note)", tone: tone)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// The server's state word, in the app's words.
    static func state(_ state: String) -> (String, Tone) {
        switch state {
        case "have": ("Have it", .ready)
        case "downloading": ("Downloading", .downloading)
        case "missing": ("Missing", .needsYou)
        case "coming": ("Coming", .neutral)
        case "not_watched": ("Not wanted", .neutral)
        default: (state.capitalized, .neutral)
        }
    }
}
