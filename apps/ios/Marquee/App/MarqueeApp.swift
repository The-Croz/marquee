import SwiftUI

@main
struct MarqueeApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Marquee")
                .font(.titleSerif(48))
                .foregroundStyle(.amber)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.ink)
                .preferredColorScheme(.dark)
        }
    }
}
