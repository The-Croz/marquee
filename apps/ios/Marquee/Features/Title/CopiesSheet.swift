import MarqueeKit
import SwiftUI

/// Copies we found: Marquee looks in your Sources and says which one it would pick, and why.
struct CopiesSheet: View {
    let model: TitleModel
    var season: Int?
    var episode: Int?
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var result: CopiesResult?
    @State private var searching = true
    @State private var problem: String?
    @State private var sending: String?
    @State private var sentMessage: String?
    @State private var confirm: CopyView?
    @State private var chosenSeason: Int?

    struct SearchBody: Encodable { var season: Int; var episode: Int? }
    struct SendBody: Encodable { var searchId: String; var copyId: String; var anyway: Bool? }

    private var seasonNumbers: [Int] { model.show.value?.seasons.map(\.season).filter { $0 != 0 } ?? [] }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if model.route.kind == .show && season == nil {
                        Picker("Season", selection: Binding(get: { chosenSeason ?? seasonNumbers.last ?? 1 }, set: { chosenSeason = $0; Task { await search() } })) {
                            ForEach(seasonNumbers, id: \.self) { Text("Season \($0)").tag($0) }
                        }
                        .pickerStyle(.menu)
                    }
                    if let sentMessage {
                        Text(sentMessage).font(.subheadline.weight(.semibold)).foregroundStyle(.readyTeal)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    if searching {
                        HStack(spacing: 10) { ProgressView().tint(.amber); Text("Looking in your Sources…").foregroundStyle(.muted) }.padding(.top, 20)
                    } else if let problem {
                        MessageView(title: problem, detail: "", actionTitle: "Try again") { Task { await search() } }
                    } else if let result {
                        content(result)
                    }
                }
                .padding(16)
            }
            .background(.ink)
            .navigationTitle("Copies we found")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await search() }
            .confirmationDialog(
                "Send a copy Marquee wouldn't pick?",
                isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
                titleVisibility: .visible,
                presenting: confirm
            ) { copy in
                Button("Send it anyway") { Task { await send(copy, anyway: true) } }
                Button("Cancel", role: .cancel) {}
            } message: { copy in
                Text(copy.rejections.first?.message ?? copy.vsYours?.message ?? "It isn't better than what you have.")
            }
        }
        .presentationBackground(Color(hex: 0x0E1117))
    }

    @ViewBuilder private func content(_ r: CopiesResult) -> some View {
        Text("Judged by \(r.profile.name).").font(.footnote).foregroundStyle(.muted)
        if let yours = r.yours {
            Text("You have: \(yours.qualityLabel)").font(.footnote).foregroundStyle(.soft)
        }
        if r.copies.isEmpty {
            MessageView(title: "No copies found.", detail: "None of your Sources had it. Marquee keeps looking by itself while it's Wanted.")
        }
        let accepted = r.copies.filter(\.accepted)
        if let best = accepted.first {
            Text("Best pick").font(.headline).foregroundStyle(.textPrimary)
            copyCard(best, r, best: true)
        }
        let others = r.copies.filter { $0.id != accepted.first?.id }.prefix(12)
        if !others.isEmpty {
            DisclosureGroup("Other copies · \(others.count)") {
                VStack(spacing: 10) { ForEach(Array(others), id: \.id) { copyCard($0, r, best: false) } }.padding(.top, 8)
            }
            .tint(.soft).foregroundStyle(.soft)
        }
    }

    private func copyCard(_ c: CopyView, _ r: CopiesResult, best: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(c.title).font(.footnote.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(2)
            Text([c.qualityLabel, c.sizeBytes.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }, c.seeders.map { "\($0) sharing" }, c.sources.first?.name].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.muted)
            if let v = c.vsYours { StateLine(text: v.message, tone: v.better ? .ready : .needsYou) }
            if !c.accepted, let why = c.rejections.first { StateLine(text: "Not picked: \(why.message)", tone: .needsYou) }
            if !c.rules.isEmpty {
                DisclosureGroup("Why?") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(c.rules.prefix(8), id: \.trashId) { rule in
                            Text("\(rule.label): \(rule.explain)").font(.caption).foregroundStyle(.soft).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.top, 4)
                }
                .font(.footnote.weight(.semibold)).tint(.soft).foregroundStyle(.soft)
            }
            Button {
                if c.accepted && (c.vsYours?.better ?? true) { Task { await send(c, anyway: false) } } else { confirm = c }
            } label: {
                if sending == c.id { ProgressView().tint(.amberInk) } else { Text("Send this copy") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(sending != nil)
            .accessibilityIdentifier("send-\(c.id ?? "x")")
        }
        .padding(12)
        .background(Color.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(best ? Color.amber.opacity(0.6) : Color.line, lineWidth: 1))
    }

    private func search() async {
        searching = true
        problem = nil
        sentMessage = nil
        let path = "\(model.base)/search"
        do {
            if model.route.kind == .movie {
                result = try await app.client.send("POST", path, body: EmptyBody())
            } else {
                let s = season ?? chosenSeason ?? seasonNumbers.last ?? 1
                result = try await app.client.send("POST", path, body: SearchBody(season: s, episode: episode))
            }
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = error.fullText
        }
        searching = false
    }

    private func send(_ c: CopyView, anyway: Bool) async {
        guard let result, let id = c.id else { return }
        sending = id
        defer { sending = nil }
        do {
            let sent: SendResult = try await app.client.send("POST", "/api/downloads", body: SendBody(searchId: result.searchId, copyId: id, anyway: anyway ? true : nil))
            sentMessage = sent.message
            await model.load(app)
        } catch {
            if case .signedOut = error { app.handle(error); return }
            problem = nil
            model.problem = error.fullText
        }
    }
}
