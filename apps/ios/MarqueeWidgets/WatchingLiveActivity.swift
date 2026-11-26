import ActivityKit
import SwiftUI
import WidgetKit

private let amber = Color(red: 0.949, green: 0.702, blue: 0.239)
private let teal = Color(red: 0.31, green: 0.82, blue: 0.773)

/// Someone watching, on the Lock Screen and in the Dynamic Island.
struct WatchingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WatchingActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(context.attributes.title).font(.custom("InstrumentSerif-Regular", size: 24)).lineLimit(1)
                    Spacer()
                    Text(context.state.status).font(.caption.weight(.semibold)).foregroundStyle(teal).lineLimit(1)
                }
                if let subtitle = context.attributes.subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                ProgressView(value: min(max(context.state.progress, 0), 1)).tint(teal)
                Text(context.attributes.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
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
                    Text("\(Int(context.state.progress * 100))%").font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: min(max(context.state.progress, 0), 1)).tint(teal)
                        Text("\(context.attributes.detail) · \(context.state.status)").font(.caption).lineLimit(1)
                    }
                }
            } compactLeading: {
                Image(systemName: "play.circle.fill").foregroundStyle(teal)
            } compactTrailing: {
                Text("\(Int(context.state.progress * 100))%").font(.caption2.weight(.semibold))
            } minimal: {
                Image(systemName: "play.circle.fill").foregroundStyle(teal)
            }
        }
    }
}
