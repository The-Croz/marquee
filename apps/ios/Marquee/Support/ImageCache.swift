import Foundation

enum ImageCache {
    /// A bigger cache than the default, so posters come back instantly: 50 MB in memory, 400 MB on disk.
    static func install() {
        URLCache.shared = URLCache(memoryCapacity: 50 * 1024 * 1024, diskCapacity: 400 * 1024 * 1024)
    }
}
