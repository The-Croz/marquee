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
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await app.becameActive() } }
        }
        .onOpenURL { url in
            // marquee://signed-in comes back to the sign-in sheet, which handles it; the rest are links into the app.
            if let link = DeepLink(url: url) { if app.phase == .signedIn { app.open(link) } else { app.pendingLink = link } }
        }
    }
}

/// The tabs. Kids get Home only; members get Home and Activity (their own requests).
struct SignedInView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let role = app.user?.role ?? .member
        let sections = ActivityTabs.sections(for: role)
        @Bindable var app = app
        TabView(selection: $app.selectedTab) {
            Tab("Home", systemImage: "house.fill", value: AppTab.home) { HomeView() }
            Tab("Discover", systemImage: "safari.fill", value: AppTab.discover) { DiscoverView() }
            Tab("Library", systemImage: "rectangle.stack.fill", value: AppTab.library) { LibraryView() }
            if !sections.isEmpty {
                Tab("Activity", systemImage: "waveform.path.ecg", value: AppTab.activity) { ActivityView(sections: sections) }
            }
            if role != .kid {
                Tab("Search", systemImage: "magnifyingglass", value: AppTab.search, role: .search) { SearchView() }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .sheet(isPresented: $app.showingYou) {
            YouSheet()
                .presentationDetents([.large])
                .presentationBackground(Color(hex: 0x0E1117))
        }
    }
}
