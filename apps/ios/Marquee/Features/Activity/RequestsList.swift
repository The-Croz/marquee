import MarqueeKit
import SwiftUI

struct RequestsList: View {
    @Environment(AppModel.self) private var app
    @State private var model: RequestsModel?
    @State private var turningDown: RequestView?
    @State private var confirmAll = false

    var body: some View {
        Group {
            if let model { content(model) } else { Color.ink }
        }
        // Once only: the refresh loop below holds on to the first model, so a new one would never load.
        .task { if model == nil { model = RequestsModel(app: app) } }
    }

    @ViewBuilder
    private func content(_ model: RequestsModel) -> some View {
        Group {
            if model.forbidden {
                MessageView(title: "Only admins can see this.", detail: "").frame(maxHeight: .infinity, alignment: .top)
            } else if model.loading && model.items.isEmpty {
                VStack(spacing: 10) { ForEach(0..<3, id: \.self) { _ in Skeleton(height: 66, radius: 14) } }
                    .padding(16).frame(maxHeight: .infinity, alignment: .top)
            } else if model.items.isEmpty, let problem = model.loadProblem {
                MessageView(title: problem.title, detail: problem.advice, actionTitle: "Try again") { Task { await model.load() } }
                    .frame(maxHeight: .infinity, alignment: .top)
            } else {
                list(model)
            }
        }
        .refreshing(every: 5) { await model.load() }
        .sheet(item: $turningDown) { r in
            TurnDownSheet(request: r) { reason in Task { await model.turnDown(r, reason: reason) } }
        }
        .confirmationDialog("Approve all \(model.waiting.count) requests?", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Approve all") { Task { await model.approveAll() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Each one is approved with its default quality profile.")
        }
        .alert("Couldn't do that", isPresented: Binding(get: { model.actionProblem != nil }, set: { if !$0 { model.actionProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.actionProblem ?? "")
        }
        .toast(Binding(get: { model.toast }, set: { model.toast = $0 }), undo: model.canUndo ? { Task { await model.undo() } } : nil)
    }

    private func list(_ model: RequestsModel) -> some View {
        List {
            if model.isAdmin {
                Section {
                    if model.waiting.isEmpty {
                        Text("Nothing is waiting for you.").font(.subheadline).foregroundStyle(.muted).listRowBackground(Color.panel)
                    }
                    ForEach(model.waiting) { r in waitingRow(r, model: model) }
                } header: {
                    HStack {
                        Text("Waiting for you · \(model.waiting.count)").font(.title3.weight(.bold)).foregroundStyle(.textPrimary).textCase(nil)
                        Spacer()
                        if model.waiting.count > 1 {
                            Button("Approve all") { confirmAll = true }
                                .font(.footnote.weight(.semibold)).foregroundStyle(.textPrimary)
                                .padding(.horizontal, 14).frame(minHeight: 44)
                                .overlay(Capsule().stroke(Color.lineStrong, lineWidth: 1))
                                .textCase(nil)
                                .accessibilityIdentifier("approve-all")
                        }
                    }
                } footer: {
                    if !model.waiting.isEmpty {
                        Text("Swipe right to approve. Tap ✕ to turn one down with a reason.").font(.caption).foregroundStyle(.dim)
                    }
                }

                Section {
                    if model.recent.isEmpty {
                        Text("Requests you've answered show up here.").font(.subheadline).foregroundStyle(.muted).listRowBackground(Color.panel)
                    }
                    ForEach(model.recent) { r in
                        RequestLink(request: r) { RequestRow(request: r) }.listRowBackground(Color.panel)
                    }
                } header: {
                    Text("Recent").font(.title3.weight(.bold)).foregroundStyle(.textPrimary).textCase(nil)
                }
            } else {
                Section {
                    if model.items.isEmpty {
                        MessageView(title: "You haven't asked for anything yet.", detail: "Ask for a movie or show from Discover.").listRowBackground(Color.clear)
                    }
                    ForEach(model.items) { r in
                        RequestLink(request: r) { RequestRow(request: r, showsPerson: false) }
                            .listRowBackground(Color.panel)
                            .swipeActions(edge: .trailing) {
                                if r.state == .pending {
                                    Button(role: .destructive) { Task { await model.takeBack(r) } } label: { Label("Take back", systemImage: "arrow.uturn.backward") }
                                }
                            }
                    }
                } header: {
                    Text("Your requests").font(.title3.weight(.bold)).foregroundStyle(.textPrimary).textCase(nil)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .listRowSeparatorTint(.line)
        .refreshable { await model.load() }
    }

    private func waitingRow(_ r: RequestView, model: RequestsModel) -> some View {
        HStack(spacing: 12) {
            PosterView(path: r.posterPath, color: nil, title: r.title, size: .w185).frame(width: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(Format.requestTitle(r)).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(2)
                Text([r.requestedBy?.name, Format.ago(r.createdAt)].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.muted)
            }
            Spacer(minLength: 0)
            Button { turningDown = r } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(.soft)
                    .frame(width: 44, height: 44).overlay(Circle().stroke(Color.lineStrong, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Turn down \(r.title)")
            Button { Task { await model.approve(r) } } label: {
                Image(systemName: "checkmark").font(.system(size: 16, weight: .bold)).foregroundStyle(.amberInk)
                    .frame(width: 44, height: 44).background(Color.amber, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(model.busy.contains(r.id))
            .accessibilityLabel("Approve \(r.title)")
            .accessibilityIdentifier("approve-\(r.id)")
        }
        .listRowBackground(Color.panel)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button { Task { await model.approve(r) } } label: { Label("Approve", systemImage: "checkmark") }.tint(.amber)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button { turningDown = r } label: { Label("Turn down…", systemImage: "xmark") }.tint(.raised)
        }
    }
}
