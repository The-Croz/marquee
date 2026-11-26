import MarqueeKit
import Observation
import SwiftUI

@Observable @MainActor
final class DiscoverModel {
    let page = Loader<DiscoverPage>()
    var type = "all"
    var service = "all"
    var genre: String?

    func load(_ app: AppModel) async {
        var path = "/api/discover?type=\(type)&service=\(service)"
        if let genre, let encoded = genre.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { path += "&genre=\(encoded)" }
        await page.run(app) { () async throws(MarqueeError) -> DiscoverPage in try await app.client.get(path) }
    }
}
