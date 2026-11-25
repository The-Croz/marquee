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
        .task { model = DownloadsModel(app: app) }
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
        let shown = model.filter == .onTheWay ? model.onTheWay : model.sharing
        return List {
            Section {
                statusLine(model)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 4, trailing: 16))
                    .listRowSeparator(.hidden)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Chip(title: "On the way · \(model.onTheWay.count)", selected: model.filter == .onTheWay) { model.filter = .onTheWay }
                        Chip(title: "Sharing · \(model.sharing.count)", selected: model.filter == .sharing) { model.filter = .sharing }
                    }
                    .padding(.horizontal, 16)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
            }

            if shown.isEmpty {
                MessageView(title: model.filter == .onTheWay ? "Nothing is downloading." : "Nothing is being shared.", detail: model.filter == .onTheWay ? "When Marquee sends a copy to qBittorrent, it shows up here." : "")
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
        .refreshable { await model.load() }
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

    private func row(_ d: DownloadView, model: DownloadsModel) -> some View {
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
