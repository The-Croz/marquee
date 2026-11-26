// swift-tools-version: 6.2
import PackageDescription

// MarqueeKit: the app's models, API client and logic. No UI, so `swift test`
// runs on a Mac (and on CI) without a simulator.
let package = Package(
    name: "MarqueeKit",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [.library(name: "MarqueeKit", targets: ["MarqueeKit"])],
    targets: [
        .target(name: "MarqueeKit"),
        .testTarget(
            name: "MarqueeKitTests",
            dependencies: ["MarqueeKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
