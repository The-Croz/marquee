import ActivityKit
import Foundation

/// The Lock Screen card for someone watching. Marquee starts it by push; the widget draws it.
struct WatchingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// 0 to 1.
        var progress: Double
        /// "Playing", "Paused · converting".
        var status: String
        /// They've stopped.
        var done: Bool
    }

    var title: String
    /// "S01E02 · Half Loop", or the year.
    var subtitle: String?
    /// "ana · Living room TV".
    var detail: String
    /// Marquee's name for this stream, sent back with the card's push address.
    var ref: String
}
