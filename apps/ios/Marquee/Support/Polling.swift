import SwiftUI

extension View {
    /// Runs `work` when the screen appears, when the app comes back to the front, and every
    /// `seconds` while the screen is showing. Stops by itself when the screen goes away.
    func refreshing(every seconds: Double, _ work: @escaping @MainActor @Sendable () async -> Void) -> some View {
        modifier(RefreshingModifier(seconds: seconds, work: work))
    }
}

private struct RefreshingModifier: ViewModifier {
    let seconds: Double
    let work: @MainActor @Sendable () async -> Void
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await work()
                try? await Task.sleep(for: .seconds(seconds))
            }
        }
    }
}
