import MarqueeKit
import Observation
import SwiftUI

/// Loads one thing from Marquee and remembers how that went: loading, there, can't reach, or not allowed.
@Observable @MainActor
final class Loader<T: Sendable> {
    private(set) var value: T?
    private(set) var problem: MarqueeError?
    private(set) var loading = true
    /// The server said this person isn't allowed (a member opening an admin page).
    private(set) var forbidden = false

    func run(_ app: AppModel, _ fetch: () async throws(MarqueeError) -> T) async {
        do {
            value = try await fetch()
            problem = nil
            forbidden = false
        } catch {
            if case .signedOut = error { app.handle(error); return }
            if error.isForbidden { forbidden = true } else { problem = error }
        }
        loading = false
    }

    func set(_ new: T?) { value = new }
}

/// Shows a loader's state: grey shapes while loading, a plain message when something's wrong, else the content.
struct LoadedView<T: Sendable, Content: View>: View {
    let loader: Loader<T>
    var forbiddenText = "Only admins can see this."
    let retry: () -> Void
    @ViewBuilder var content: (T) -> Content

    var body: some View {
        if let value = loader.value {
            content(value)
        } else if loader.forbidden {
            MessageView(title: forbiddenText, detail: "").frame(maxHeight: .infinity, alignment: .top)
        } else if loader.loading {
            VStack(spacing: 10) { ForEach(0..<3, id: \.self) { _ in Skeleton(height: 66, radius: 14) } }
                .padding(16).frame(maxHeight: .infinity, alignment: .top)
                .accessibilityLabel("Loading")
        } else if let problem = loader.problem {
            MessageView(title: problem.title, detail: problem.advice, actionTitle: "Try again", action: retry)
                .frame(maxHeight: .infinity, alignment: .top)
        }
    }
}

/// A short plain-English alert for something that didn't work.
extension View {
    func problemAlert(_ text: Binding<String?>) -> some View {
        alert("Couldn't do that", isPresented: Binding(get: { text.wrappedValue != nil }, set: { if !$0 { text.wrappedValue = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(text.wrappedValue ?? "")
        }
    }
}
