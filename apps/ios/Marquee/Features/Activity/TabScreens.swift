import MarqueeKit
import SwiftUI

/// The Requests tab: what's waiting, and how earlier asks went.
struct RequestsScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.requestsPath) {
            RequestsList().modifier(TabChrome(title: "Requests"))
        }
    }
}

/// The Downloads tab (admins).
struct DownloadsScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.downloadsPath) {
            DownloadsList().modifier(TabChrome(title: "Downloads"))
        }
    }
}

/// The title, background, avatar and title pages every list tab shares.
private struct TabChrome: ViewModifier {
    @Environment(AppModel.self) private var app
    let title: String

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.ink)
            .navigationTitle(title)
            .navigationDestination(for: TitleRoute.self) { TitleView(route: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    AvatarButton { app.showingYou = true }.accessibilityIdentifier("avatar")
                }
            }
    }
}

/// Watching, opened from Home (admins).
struct WatchingScreen: View {
    var body: some View {
        WatchingList()
            .background(.ink)
            .navigationTitle("Watching")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
    }
}

/// A place Home can go that isn't a title.
enum HomeDestination: Hashable { case watching }
