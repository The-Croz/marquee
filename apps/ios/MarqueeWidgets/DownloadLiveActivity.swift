import ActivityKit
import SwiftUI
import WidgetKit

private let amber = Color(red: 0.949, green: 0.702, blue: 0.239)
private let blue = Color(red: 0.416, green: 0.651, blue: 1.0)
private let teal = Color(red: 0.31, green: 0.82, blue: 0.773)

/// A download on the Lock Screen and in the Dynamic Island.
struct DownloadLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DownloadActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(context.attributes.title).font(.custom("InstrumentSerif-Regular", size: 24)).lineLimit(1)
                    Spacer()
                    Text(context.state.done ? "Ready" : "\(Int(context.state.progress * 100))%").font(.headline).foregroundStyle(context.state.done ? teal : blue)
                }
                ProgressView(value: context.state.progress).tint(context.state.done ? teal : blue)
                Text(context.state.done ? "In your library" : context.state.status).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            .padding(16)
            .activityBackgroundTint(Color(red: 0.039, green: 0.047, blue: 0.063))
            .activitySystemActionForegroundColor(amber)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.attributes.title).font(.custom("InstrumentSerif-Regular", size: 20)).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.done ? "Ready" : "\(Int(context.state.progress * 100))%").font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: context.state.progress).tint(blue)
                        Text(context.state.done ? "In your library" : context.state.status).font(.caption).lineLimit(1)
                    }
                }
            } compactLeading: {
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(blue)
            } compactTrailing: {
                Text(context.state.done ? "✓" : "\(Int(context.state.progress * 100))%").font(.caption2.weight(.semibold))
            } minimal: {
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(blue)
            }
        }
    }
}
