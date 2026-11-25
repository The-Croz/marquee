import MarqueeKit
import SwiftUI

/// One episode up close (admins): its files, the downloads that hold it, and whether it's Wanted.
struct EpisodeSheet: View {
    let model: TitleModel
    let season: Int
    let episode: EpisodeView
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var detail = Loader<EpisodeDetailView>()
    @State private var wanted: Bool
    @State private var lookForCopies = false

    init(model: TitleModel, season: Int, episode: EpisodeView) {
        self.model = model
        self.season = season
        self.episode = episode
        _wanted = State(initialValue: episode.wanted)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(episode.title ?? "Episode \(episode.episode)").font(.titleSerif(30)).foregroundStyle(.textPrimary)
                    Text("Season \(season) · Episode \(episode.episode)" + (episode.airDate.map { " · \($0)" } ?? "")).font(.footnote).foregroundStyle(.muted)
                    if let overview = detail.value?.overview { Text(overview).font(.subheadline).foregroundStyle(.soft) }

                    PanelCard {
                        Toggle(isOn: Binding(get: { wanted }, set: { v in wanted = v; Task { await model.setEpisodeWanted(app, season: season, episode: episode.episode, v) } })) {
                            Text("Wanted").font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                        }
                        .tint(.amber).padding(12)
                    }

                    if let d = detail.value {
                        if d.files.isEmpty {
                            Text("No file for this episode yet.").font(.subheadline).foregroundStyle(.muted)
                        }
                        ForEach(d.files) { f in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(f.name).font(.footnote.weight(.semibold)).foregroundStyle(.textPrimary)
                                Text("\(f.quality.label) · \(ByteCountFormatter.string(fromByteCount: Int64(f.sizeBytes), countStyle: .file))\(f.otherEpisodes.isEmpty ? "" : " · also holds episodes \(f.otherEpisodes.map(String.init).joined(separator: ", "))")").font(.caption).foregroundStyle(.muted)
                            }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .accessibilityElement(children: .combine)
                        }
                        ForEach(d.torrents) { t in
                            Text("In qBittorrent: \(t.name)\(t.wholeSeason ? " (the whole season)" : "")").font(.caption).foregroundStyle(.soft)
                        }
                        if let note = d.downloaderNote { Text(note).font(.caption).foregroundStyle(.muted) }
                    } else if detail.loading {
                        Skeleton(height: 60)
                    }
                    Button("Look for copies of this episode") { lookForCopies = true }.buttonStyle(QuietButtonStyle())
                }
                .padding(16)
            }
            .background(.ink)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task {
                await detail.run(app) { () async throws(MarqueeError) -> EpisodeDetailView in
                    try await app.client.get("\(model.base)/seasons/\(season)/episodes/\(episode.episode)")
                }
            }
            .sheet(isPresented: $lookForCopies) { CopiesSheet(model: model, season: season, episode: episode.episode) }
        }
        .presentationDetents([.large])
        .presentationBackground(Color(hex: 0x0E1117))
    }
}
