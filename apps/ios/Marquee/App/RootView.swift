import MarqueeKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                ProgressView().tint(.amber).frame(maxWidth: .infinity, maxHeight: .infinity).background(.ink)
            case .needsAddress:
                AddressView()
            case .signedOut:
                SignInView()
            case .signedIn:
                SignedInView()
            case .cantReach(let error):
                VStack(spacing: 16) {
                    MessageView(title: error.title, detail: error.advice, actionTitle: "Try again") { Task { await app.retryLaunch() } }
                    Button("Change server") { app.changeServer() }.font(.footnote.weight(.semibold)).foregroundStyle(.amber).frame(minHeight: 44)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.ink)
            }
        }
        .preferredColorScheme(.dark)
        .tint(.amber)
        .task { await app.start() }
        .task { await PushCenter.shared.askOnFirstOpen() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await app.becameActive()
                    // Notifications may have been allowed in iOS Settings while the app was away.
                    await PushCenter.shared.refresh()
                    await LiveActivityController.shared.sendStartTokens(app)
                }
            }
        }
        .onOpenURL { url in
            // marquee://signed-in comes back to the sign-in sheet, which handles it; the rest are links into the app.
            if let link = DeepLink(url: url) { if app.phase == .signedIn { app.open(link) } else { app.pendingLink = link } }
        }
    }
}

/// The tabs along the bottom (see `MainTab` for who gets which). Watching has no tab:
/// it opens from Home, whose tab carries the number of streams playing.
struct SignedInView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let tabs = MainTab.tabs(for: app.user?.role ?? .member)
        @Bindable var app = app
        TabView(selection: $app.selectedTab) {
            Tab("Home", systemImage: "house.fill", value: MainTab.home) { HomeView() }
                .badge(app.counts.playing)
            Tab("Discover", systemImage: "safari.fill", value: MainTab.discover) { DiscoverView() }
            Tab("Library", systemImage: "rectangle.stack.fill", value: MainTab.library) { LibraryView() }
            if tabs.contains(.requests) {
                Tab("Requests", systemImage: "tray.full.fill", value: MainTab.requests) { RequestsScreen() }
                    .badge(app.counts.requests)
            }
            if tabs.contains(.downloads) {
                Tab("Downloads", systemImage: "arrow.down.circle.fill", value: MainTab.downloads) { DownloadsScreen() }
                    .badge(app.counts.downloads)
            }
        }
        .refreshing(every: 15) { await app.loadCounts() }
        .tabBarMinimizeBehavior(.onScrollDown)
        .task {
            await PushCenter.shared.refresh()
            await LiveActivityController.shared.sendStartTokens(app)
        }
        .sheet(item: $app.turnDownRequest) { r in
            TurnDownSheet(request: r) { reason in Task { await app.turnDown(r, reason: reason) } }
        }
        .sheet(isPresented: $app.showingYou) {
            YouSheet()
                .presentationDetents([.large])
                .presentationBackground(Color(hex: 0x0E1117))
        }
    }
}
