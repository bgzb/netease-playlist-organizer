import AppKit
import Foundation

struct ListenerInspector {
    static func parse(_ output: String, port: Int) throws -> PortInspection {
        if output.isEmpty { return .free }
        var currentPID: Int32?
        var listeners: [(Int32, Bool)] = []
        for line in output.split(separator: "\n") {
            if line.hasPrefix("p") {
                guard let pid = Int32(line.dropFirst()), pid > 0 else { throw LauncherError.listenerInspectionFailed }
                currentPID = pid
            } else if line.hasPrefix("n") {
                guard let pid = currentPID else { throw LauncherError.listenerInspectionFailed }
                let name = String(line.dropFirst())
                guard name.hasSuffix(":\(port)") else { throw LauncherError.listenerInspectionFailed }
                let loopback = name == "127.0.0.1:\(port)" || name == "[::1]:\(port)"
                listeners.append((pid, loopback))
            }
        }
        guard !listeners.isEmpty else { throw LauncherError.listenerInspectionFailed }
        var owners: [Int32: Bool] = [:]
        for (pid, loopback) in listeners { owners[pid] = (owners[pid] ?? true) && loopback }
        guard owners.count == 1, let owner = owners.first else { return .conflict(owners: owners) }
        return .owned(pid: owner.key, loopback: owner.value)
    }

    static func inspect(port: Int) throws -> PortInspection {
        let result = try Command.run("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpn"])
        if result.status == 1 && result.stdout.isEmpty && result.stderr.isEmpty { return .free }
        guard result.status == 0, result.stderr.isEmpty else { throw LauncherError.listenerInspectionFailed }
        return try parse(result.stdout, port: port)
    }
}

private struct Command {
    struct Result { let status: Int32; let stdout: String; let stderr: String }
    static func run(_ path: String, _ args: [String]) throws -> Result {
        let process = Process(); process.executableURL = URL(fileURLWithPath: path); process.arguments = args
        let output = Pipe(); let errors = Pipe(); process.standardOutput = output; process.standardError = errors
        try process.run()
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        guard !process.isRunning else {
            process.terminate() // Only this utility subprocess; never the music client.
            throw LauncherError.listenerInspectionFailed
        }
        return Result(status: process.terminationStatus,
                      stdout: String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self),
                      stderr: String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
    }
}

// Injectable boundaries retain a specific NSRunningApplication in production and
// permit lifecycle tests without opening, inspecting or terminating real apps.
@MainActor protocol ClientApplication {
    var identity: ClientIdentity? { get }
    var bundleURL: URL? { get }
    var isTerminated: Bool { get }
    func terminate() -> Bool
}

@MainActor protocol ClientRuntime {
    var applicationURL: URL? { get }
    var running: [any ClientApplication] { get }
    func version(at url: URL) -> (String, String)
    func arguments(pid: Int32) throws -> String
    func inspectListener(port: Int) throws -> PortInspection
    func open(at url: URL, debugPort: Int?, completion: @escaping @MainActor (Result<any ClientApplication, Error>) -> Void)
}

@MainActor private final class LiveClientApplication: ClientApplication {
    private let application: NSRunningApplication
    let identity: ClientIdentity?
    init(_ application: NSRunningApplication) {
        self.application = application
        identity = application.launchDate.map { ClientIdentity(pid: application.processIdentifier, startedAt: $0) }
    }
    var bundleURL: URL? { application.bundleURL }
    var isTerminated: Bool { application.isTerminated }
    func terminate() -> Bool { application.terminate() }
}

@MainActor private final class WorkspaceRuntime: ClientRuntime {
    var applicationURL: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: ClientProcess.bundleID) }
    var running: [any ClientApplication] {
        NSRunningApplication.runningApplications(withBundleIdentifier: ClientProcess.bundleID).map { LiveClientApplication($0) }
    }
    func version(at url: URL) -> (String, String) {
        let bundle = Bundle(url: url)
        return (bundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                bundle?.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "")
    }
    func arguments(pid: Int32) throws -> String {
        try Command.run("/bin/ps", ["-p", String(pid), "-o", "command="]).stdout
    }
    func inspectListener(port: Int) throws -> PortInspection { try ListenerInspector.inspect(port: port) }
    func open(at url: URL, debugPort: Int?, completion: @escaping @MainActor (Result<any ClientApplication, Error>) -> Void) {
        let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = true
        if debugPort != nil {
            configuration.arguments = ["--remote-debugging-port=19319", "--remote-debugging-address=127.0.0.1"]
        }
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
            Task { @MainActor in
                if let error { completion(.failure(error)) }
                else if let app { completion(.success(LiveClientApplication(app))) }
                else { completion(.failure(LauncherError.appMissing)) }
            }
        }
    }
}

@MainActor final class ClientProcess: ClientProcessControlling {
    nonisolated static let bundleID = "com.netease.163music"
    private let runtime: any ClientRuntime
    private let launchTimeout: TimeInterval
    private let recordFailure: FailureRecorder
    private var captured: [ClientIdentity: any ClientApplication] = [:]

    init(recordFailure: @escaping FailureRecorder = NativeFailureDiagnostics.record,
         runtime: (any ClientRuntime)? = nil, launchTimeout: TimeInterval = 15) {
        self.recordFailure = recordFailure
        self.runtime = runtime ?? WorkspaceRuntime(); self.launchTimeout = launchTimeout
    }

    func inspect() -> ClientState {
        let applications = runtime.running
        guard let url = applications.first?.bundleURL ?? runtime.applicationURL else { return .unsupported(version: "未安装", build: "") }
        let (version, build) = runtime.version(at: url)
        guard version == "3.1.1", build == "3019" else { return .unsupported(version: version, build: build) }
        guard let app = applications.first else { return .notRunning }
        guard applications.count == 1, let identity = app.identity else { return .unsupported(version: "无法确认运行实例", build: build) }
        let pid = identity.pid
        if (try? runtime.arguments(pid: pid).contains("--remote-debugging-port=19319")) == true {
            return .debug(pid: pid, port: 19319)
        }
        if let listener = try? inspectListener(port: 19319), case .owned(let owner, _) = listener, owner == pid {
            return .debug(pid: pid, port: 19319)
        }
        return .regular(pid: pid)
    }

    func inspectListener(port: Int) throws -> PortInspection { try runtime.inspectListener(port: port) }

    private func retain(_ application: any ClientApplication) throws -> ClientIdentity {
        guard let identity = application.identity else {
            recordFailure(FailureRecord(stage: .retainIdentity, failure: .disconnected))
            throw LauncherError.disconnected
        }
        captured = captured.filter { !$0.value.isTerminated }
        if captured[identity] == nil { captured[identity] = application }
        return identity
    }

    func captureIdentity(pid: Int32) throws -> ClientIdentity {
        let applications = runtime.running
        guard applications.count == 1, let app = applications.first, app.identity?.pid == pid else {
            recordFailure(FailureRecord(stage: .captureIdentity, failure: .disconnected))
            throw LauncherError.disconnected
        }
        return try retain(app)
    }

    func isRunning(identity: ClientIdentity) -> Bool {
        // Original retained-handle guard precedes enumeration; diagnostics run only after failure.
        guard let app = captured[identity], !app.isTerminated else {
            let retained = captured[identity]
            let applications = runtime.running
            let current = applications.first?.identity
            recordFailure(FailureRecord(stage: .retainedIdentity, failure: .disconnected, identity: IdentityFailure(
                capturedPresent: retained != nil, capturedTerminated: retained != nil,
                currentCountIsOne: applications.count == 1, currentPidMatches: current?.pid == identity.pid,
                currentStartedAtMatches: current?.startedAt == identity.startedAt, identityPresent: current != nil)))
            return false
        }
        let applications = runtime.running
        let matches = applications.count == 1 && applications.first?.identity == identity
        if !matches {
            let current = applications.first?.identity
            recordFailure(FailureRecord(stage: .currentIdentity, failure: .disconnected, identity: IdentityFailure(
                capturedPresent: true, capturedTerminated: false,
                currentCountIsOne: applications.count == 1, currentPidMatches: current?.pid == identity.pid,
                currentStartedAtMatches: current?.startedAt == identity.startedAt, identityPresent: current != nil)))
        }
        return matches
    }

    func start(debugPort: Int?) async throws -> ClientIdentity {
        try Task.checkCancellation()
        guard runtime.running.isEmpty else { throw LauncherError.operationInProgress }
        guard let url = runtime.applicationURL else { throw LauncherError.appMissing }
        if case .unsupported = inspect() { throw LauncherError.unsupportedClient }
        if let port = debugPort {
            guard port == 19319 else { throw LauncherError.targetUnavailable }
            guard try inspectListener(port: port) == .free else { throw LauncherError.portOccupied }
        }
        let request = LaunchRequest()
        runtime.open(at: url, debugPort: debugPort) { [self] result in
            request.result = result.flatMap { application in Result { try retain(application) } }
            if request.abandoned, case .success(let identity) = request.result {
                inspectAbandonedLaunch(identity: identity, debugPort: debugPort)
            }
        }
        do {
            let deadline = Date().addingTimeInterval(launchTimeout)
            while Date() < deadline {
                if let result = request.result { return try result.get() }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            throw LauncherError.timeout
        } catch {
            request.abandoned = true
            // Also cover a completion arriving at the deadline before the last poll.
            if case .success(let identity) = request.result {
                inspectAbandonedLaunch(identity: identity, debugPort: debugPort)
            }
            throw error
        }
    }

    private func inspectAbandonedLaunch(identity: ClientIdentity, debugPort: Int?) {
        guard let port = debugPort, isRunning(identity: identity),
              let listener = try? inspectListener(port: port),
              listener.hasUnsafeBinding(ownedBy: identity.pid) else { return }
        Task { [self] in
            // A replacement/refused quit leaves the tool disconnected; never target
            // a newly resolved process or claim that a failed cleanup closed the port.
            try? await terminateNormally(expected: identity)
        }
    }

    func terminateNormally(expected: ClientIdentity) async throws {
        // Use the captured handle, never a newly resolved current-bundle process.
        guard isRunning(identity: expected), let app = captured[expected] else { throw LauncherError.disconnected }
        guard app.terminate() else { throw LauncherError.normalQuitRefused }
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if app.isTerminated { captured.removeValue(forKey: expected); return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw LauncherError.timeout
    }
}

@MainActor private final class LaunchRequest {
    var result: Result<ClientIdentity, Error>?
    var abandoned = false
}
