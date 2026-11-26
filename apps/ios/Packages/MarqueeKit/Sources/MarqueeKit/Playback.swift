import Foundation

/// Where a stream is, in words.
public enum Playback {
    /// "1:01:25 of 2:46:00", or the percent when the server doesn't say how long it runs.
    public static func position(progress: Double, durationMs: Double?) -> String {
        guard let durationMs, durationMs > 0 else { return "\(Int((progress * 100).rounded()))%" }
        return "\(clock(progress * durationMs)) of \(clock(durationMs))"
    }

    /// When it will finish if it keeps playing.
    public static func end(progress: Double, durationMs: Double?, state: String, from now: Date = Date()) -> Date? {
        guard let durationMs, durationMs > 0, state == "playing" else { return nil }
        return now.addingTimeInterval((1 - progress) * durationMs / 1000)
    }

    private static func clock(_ ms: Double) -> String {
        let s = max(0, Int((ms / 1000).rounded()))
        let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60)
        let minutes = h > 0 ? "\(h):\(m < 10 ? "0" : "")\(m)" : "\(m)"
        return "\(minutes):\(sec < 10 ? "0" : "")\(sec)"
    }
}
