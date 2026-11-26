import MarqueeKit
import SwiftUI

struct DownloadsList: View {
    @Environment(AppModel.self) private var app
    @State private var model: DownloadsModel?
    @State private var removing: DownloadView?

    var body: some View {
        Group {
            if let model { content(model) } else { Color.ink }
        }
        // Once only: the refresh loop below holds on to the first model, so a new one would never load.
        .task { if model == nil { model = DownloadsModel(app: app) } }
    }

    @ViewBuilder
    private func content(_ model: DownloadsModel) -> some View {
        Group {
            if model.forbidden {
                MessageView(title: "Only admins can see this.", detail: "")
                    .frame(maxHeight: .infinity, alignment: .top)
            } else if model.loading && model.view == nil {
                VStack(spacing: 10) { ForEach(0..<3, id: \.self) { _ in Skeleton(height: 66, radius: 14) } }
                    .padding(16).frame(maxHeight: .infinity, alignment: .top)
            } else if model.view == nil, let problem = model.loadProblem {
                MessageView(title: problem.title, detail: problem.advice, actionTitle: "Try again") { Task { await model.load() } }
                    .frame(maxHeight: .infinity, alignment: .top)
            } else {
                list(model)
            }
        }
        .refreshing(every: 5) { await model.load() }
        .confirmationDialog(
            "Remove it from qBittorrent?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible,
            presenting: removing
        ) { d in
            Button("Remove and delete its files", role: .destructive) { Task { await model.remove(d, deleteFiles: true) } }
            Button("Remove, keep the files") { Task { await model.remove(d, deleteFiles: false) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Marquee won't try another copy. You can search again from the title's page.")
        }
        .alert("Couldn't do that", isPresented: Binding(get: { model.actionProblem != nil }, set: { if !$0 { model.actionProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.actionProblem ?? "")
        }
        .toast(Binding(get: { model.toast ?? LiveActivityController.shared.message }, set: { model.toast = $0; LiveActivityController.shared.message = nil }))
    }

    private func list(_ model: DownloadsModel) -> some View {
        let shown: [DownloadView] = switch model.filter {
        case .onTheWay: model.onTheWay
        case .needsALook: model.needsALook
        case .sharing: model.sharing
        case .history: []
        }
        return List {
            Section {
                statusLine(model)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))
                    .listRowSeparator(.hidden)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Chip(title: "On the way · \(model.onTheWay.count)", selected: model.filter == .onTheWay) { model.filter = .onTheWay }
                        // Failed copies used to vanish from the phone: they get their own chip, only when there are some.
                        if !model.needsALook.isEmpty || model.filter == .needsALook {
                            Chip(title: "Needs a look · \(model.needsALook.count)", selected: model.filter == .needsALook) { model.filter = .needsALook }
                                .accessibilityIdentifier("needs-a-look")
                        }
                        Chip(title: "Sharing · \(model.sharing.count)", selected: model.filter == .sharing) { model.filter = .sharing }
                        Chip(title: "History", selected: model.filter == .history) { model.filter = .history }
                            .accessibilityIdentifier("download-history")
                    }
                }
                .scrollClipDisabled()
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
            }

            if model.filter == .history {
                historySection(model)
            } else if shown.isEmpty {
                MessageView(title: emptyTitle(model.filter), detail: model.filter == .onTheWay ? "When Marquee sends a copy to qBittorrent, it shows up here." : "")
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else {
                Section {
                    ForEach(shown) { d in row(d, model: model) }
                }
                .listRowBackground(Color.panel)
                .listRowSeparatorTint(.line)
            }

            if model.filter == .onTheWay, !model.finishedToday.isEmpty {
                Section {
                    ForEach(model.finishedToday) { d in row(d, model: model) }
                } header: {
                    Text("Today").font(.footnote.weight(.semibold)).foregroundStyle(.muted).textCase(nil)
                }
                .listRowBackground(Color.panel)
                .listRowSeparatorTint(.line)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await model.load(); if model.filter == .history { await model.loadHistory() } }
        .task(id: model.filter) { if model.filter == .history { await model.loadHistory() } }
        // Once the last failed copy is dealt with, its chip goes, so go back to what's on the way.
        .onChange(of: model.needsALook.isEmpty) { _, empty in if empty && model.filter == .needsALook { model.filter = .onTheWay } }
    }

    private func emptyTitle(_ filter: DownloadsFilter) -> String {
        switch filter {
        case .onTheWay: "Nothing is downloading."
        case .needsALook: "Nothing needs a look."
        case .sharing: "Nothing is being shared."
        case .history: ""
        }
    }

    @ViewBuilder
    private func historySection(_ model: DownloadsModel) -> some View {
        if let items = model.history {
            if items.isEmpty {
                MessageView(title: "No history yet.", detail: "Copies Marquee sends, brings in or replaces are listed here.")
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else {
                Section {
                    ForEach(items) { h in historyRow(h) }
                } footer: {
                    Text("The full history, with filters, is on the web under Downloads → History.").font(.caption)
                }
                .listRowBackground(Color.panel)
                .listRowSeparatorTint(.line)
            }
        } else if let problem = model.historyProblem {
            MessageView(title: "Couldn't load the history.", detail: problem, actionTitle: "Try again") { Task { await model.loadHistory() } }
                .listRowBackground(Color.clear)
        } else {
            Skeleton(height: 66, radius: 14).listRowBackground(Color.clear)
        }
    }

    @ViewBuilder
    private func historyRow(_ h: HistoryItem) -> some View {
        let tone: Tone = switch h.tone {
        case "good": .ready
        case "bad": .needsYou
        case "busy": .downloading
        default: .neutral
        }
        let content = VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(h.titleName).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(1)
                Spacer(minLength: 8)
                Text(Format.ago(h.at)).font(.caption).foregroundStyle(.dim)
            }
            StateLine(text: [h.label, h.quality, h.who].compactMap { $0 }.joined(separator: " · "), tone: tone)
            if let detail = h.detail { Text(detail).font(.caption2).foregroundStyle(.muted).fixedSize(horizontal: false, vertical: true) }
            if let copy = h.copy { Text(copy).font(.caption2.monospaced()).foregroundStyle(.dim).lineLimit(1).truncationMode(.middle) }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        if let route = TitleRoute(webPath: h.titleLink) {
            NavigationLink(value: route) { content }
        } else {
            content
        }
    }

    @ViewBuilder
    private func statusLine(_ model: DownloadsModel) -> some View {
        if let problem = model.view?.problem {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("qBittorrent · \(problem.label)").font(.subheadline.weight(.semibold)).foregroundStyle(.warn)
                    if let fix = problem.fix { Text(fix).font(.caption).foregroundStyle(.soft) }
                    Text("What's below may be out of date.").font(.caption).foregroundStyle(.muted)
                }
                Spacer()
                Circle().fill(Color.warn).frame(width: 10, height: 10).padding(.top, 5)
            }
            .padding(12)
            .background(Color.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color(hex: 0x3A2A22), lineWidth: 1))
            .accessibilityElement(children: .combine)
        } else if model.view != nil {
            let down = model.onTheWay.reduce(0) { $0 + ($1.speed ?? 0) }
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("qBittorrent · working").font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                    Text(down > 0 ? "↓ \(Self.rate(down))" : "Nothing downloading right now").font(.caption).foregroundStyle(.muted)
                }
                Spacer()
                Circle().fill(Color.readyTeal).frame(width: 10, height: 10)
            }
            .padding(12)
            .background(Color.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.line, lineWidth: 1))
            .accessibilityElement(children: .combine)
        }
    }

    private static func rate(_ bytesPerSecond: Double) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        return f.string(fromByteCount: Int64(bytesPerSecond)) + "/s"
    }

    /// A row that opens its movie or show, when the library has a page for it.
    private func row(_ d: DownloadView, model: DownloadsModel) -> some View {
        Group {
            if let route = TitleRoute(webPath: d.titleLink) {
                NavigationLink(value: route) { rowContent(d) }.accessibilityIdentifier("download-\(d.id)")
            } else {
                rowContent(d)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if d.canControl || d.canRemoveShared {
                Button(role: .destructive) { removing = d } label: { Label("Remove", systemImage: "trash") }
            }
            if d.state == .sent || d.state == .downloading {
                Button { Task { await LiveActivityController.shared.follow(d, app: app) } } label: { Label("Follow on Lock Screen", systemImage: "lock.iphone") }
                    .tint(.downloadBlue)
            }
            if d.canTryAnother {
                Button { Task { await model.act(d, "try-another") } } label: { Label("Find a better copy", systemImage: "arrow.triangle.2.circlepath") }
                    .tint(.raised)
            }
        }
        .swipeActions(edge: .leading) {
            if d.canControl, d.state == .sent || d.state == .downloading {
                if d.isPaused {
                    Button { Task { await model.act(d, "resume") } } label: { Label("Resume", systemImage: "play.fill") }.tint(.readyTeal)
                } else {
                    Button { Task { await model.act(d, "pause") } } label: { Label("Pause", systemImage: "pause.fill") }.tint(.downloadBlue)
                }
            }
        }
    }

    private func rowContent(_ d: DownloadView) -> some View {
        let tone = Self.tone(d)
        return HStack(spacing: 12) {
            PosterView(path: d.posterPath, color: d.posterColor, title: d.titleName, size: .w185).frame(width: 36)
            VStack(alignment: .leading, spacing: 4) {
                Text(d.titleName).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(1)
                if d.state == .sent || d.state == .downloading {
                    ProgressView(value: d.progress).progressViewStyle(BarStyle(fill: tone.color))
                }
                StateLine(text: d.status.label, tone: tone)
                if let detail = d.status.detail, tone == .needsYou || d.state == .failed {
                    Text(detail).font(.caption2).foregroundStyle(.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// The row's colour: the server's own tone, in the app's words.
    static func tone(_ d: DownloadView) -> Tone {
        switch d.status.tone {
        case .warn, .bad: .needsYou
        case .done: .ready
        case .good, .busy: .downloading
        default: .neutral
        }
    }
}
