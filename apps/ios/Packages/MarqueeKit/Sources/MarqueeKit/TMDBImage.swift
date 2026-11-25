import Foundation

/// Pictures come straight from TMDB, the same way the web app loads them.
public enum TMDBImage {
    public enum Size: String, Sendable {
        /// List rows.
        case w185
        /// Poster rows and grids.
        case w342
        /// Backdrops.
        case w1280
    }

    public static func url(path: String?, size: Size) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        let clean = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return URL(string: "https://image.tmdb.org/t/p/\(size.rawValue)/\(clean)")
    }
}
