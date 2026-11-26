import ActivityKit
import Foundation

/// The Lock Screen card for a download on its way. Shared by the app (which starts it) and the widget (which draws it).
struct DownloadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// 0 to 1.
        var progress: Double
        /// Plain words: "Downloading · 4.2 MB/s · about 12 min left".
        var status: String
        /// Seconds left, when known.
        var eta: Double?
        /// It's in the library.
        var done: Bool
    }

    var title: String
    var downloadId: Int
}
