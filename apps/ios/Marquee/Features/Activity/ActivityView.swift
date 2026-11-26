import MarqueeKit
import SwiftUI

/// Activity: downloads (admins) and requests.
struct ActivityView: View {
    @Environment(AppModel.self) private var app
    let sections: [ActivitySection]

    var body: some View {
        @Bindable var app = app
        let selected = sections.contains(app.activitySection) ? app.activitySection : sections[0]
        NavigationStack {
            VStack(spacing: 0) {
                if sections.count > 1 {
                    Picker("Section", selection: $app.activitySection) {
                        ForEach(sections, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }
                switch selected {
                case .downloads: DownloadsList()
                case .requests: RequestsList()
                case .watching: WatchingList()
                }
            }
            .background(.ink)
            .navigationTitle("Activity")
            .navigationDestination(for: TitleRoute.self) { TitleView(route: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    AvatarButton(initial: app.user?.displayName ?? "?") { app.showingYou = true }
                        .accessibilityIdentifier("avatar")
                }
            }
        }
    }
}
