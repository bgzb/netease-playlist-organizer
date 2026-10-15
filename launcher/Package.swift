// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OrganizerLauncher",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "OrganizerLauncher", targets: ["OrganizerLauncher"])],
    targets: [
        .executableTarget(name: "OrganizerLauncher", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "OrganizerLauncherTests", dependencies: ["OrganizerLauncher"], swiftSettings: [.swiftLanguageMode(.v5)])
    ]
)
