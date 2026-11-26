import SwiftUI

@main
struct MarqueeApp: App {
    @State private var model = AppModel()

    init() {
        ImageCache.install()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}
