import SwiftUI

@main
struct MarqueeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    init() {
        ImageCache.install()
        PushCenter.shared.install(app: .shared)
        // From the start, so a card Marquee starts while the app is closed can be kept up to date.
        LiveActivityController.shared.watch(app: .shared)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}
