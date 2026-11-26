import Foundation
import MarqueeKit

enum Format {
    /// "2 hr. ago", "yesterday".
    static func ago(_ ms: Int64) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.dateTimeStyle = .named
        return formatter.localizedString(for: date(fromMilliseconds: ms), relativeTo: .now)
    }

    /// "Bluey · Season 3" for a request that names seasons.
    static func requestTitle(_ r: RequestView) -> String {
        guard r.kind == .series, let seasons = r.seasons, !seasons.isEmpty else { return r.title }
        return seasons.count == 1 ? "\(r.title) · Season \(seasons[0])" : "\(r.title) · Seasons \(seasons.map(String.init).joined(separator: ", "))"
    }

    static func isToday(_ ms: Int64?) -> Bool {
        guard let ms else { return false }
        return Calendar.current.isDateInToday(date(fromMilliseconds: ms))
    }
}
