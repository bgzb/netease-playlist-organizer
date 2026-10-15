import Foundation

@MainActor final class Coordinator {
    static let debugPort = 19319
    private let process: any ClientProcessControlling
    private let connector: any DebugConnecting
    private let recordFailure: FailureRecorder
    private var debug: (any DebugCalling)?
    private var busy = false
    private var connectedPID: Int32?
    private var connectionGeneration: UInt64 = 0
    private(set) var connected = false

    init(recordFailure: @escaping FailureRecorder = NativeFailureDiagnostics.record,
         process: any ClientProcessControlling, connector: any DebugConnecting) {
        self.recordFailure = recordFailure
        self.process = process; self.connector = connector
    }

    func connectAndLoad(script: String, restartApproved: Bool) async throws -> LoadStatus {
        guard !busy else { throw LauncherError.operationInProgress }
        busy = true; defer { busy = false }
        await disconnect()
        let initial = process.inspect()
        switch initial {
        case .unsupported: throw LauncherError.unsupportedClient
        case .regular where !restartApproved: throw LauncherError.restartApprovalRequired
        default: break
        }
        // Check before terminating a regular instance or launching any process.
        let listener = try process.inspectListener(port: Self.debugPort)
        switch initial {
        case .debug(let pid, let port):
            guard port == Self.debugPort else { throw LauncherError.targetUnavailable }
            try validateListener(listener, expectedPID: pid)
        case .regular, .notRunning:
            guard listener == .free else { throw LauncherError.portOccupied }
        case .unsupported: throw LauncherError.unsupportedClient
        }
        var launched: ClientIdentity?
        do {
            switch initial {
            case .regular(let pid):
                let approvedInstance = try process.captureIdentity(pid: pid)
                try await process.terminateNormally(expected: approvedInstance)
                guard try process.inspectListener(port: Self.debugPort) == .free else { throw LauncherError.portOccupied }
                launched = try await process.start(debugPort: Self.debugPort)
            case .notRunning:
                launched = try await process.start(debugPort: Self.debugPort)
            default: break
            }
            if let launched { try await waitForDebugInstance(expected: launched) }
            // Revalidate immediately before every new connection; never retain a stale target ID.
            guard case .debug(let pid, let port) = process.inspect(), port == Self.debugPort else { throw failed(.connectState, .disconnected) }
            let instance = try process.captureIdentity(pid: pid)
            if let launched, instance != launched { throw failed(.connectIdentity, .disconnected) }
            let client = try await connector.connect(port: Self.debugPort, startupValidate: { [self] deadline in
                try await validateStartupInstance(instance, until: deadline)
            })
            debug = client; connectionGeneration &+= 1
            try await waitForFrontend(expected: instance)
            _ = try await startupEvaluate(script, expected: instance)
            let value = try await startupEvaluate("window.__ncmOrganizerV1.status()", expected: instance)
            let status = try JSONDecoder().decode(LoadStatus.self, from: JSONEncoder().encode(value))
            guard status.installed, status.readReady, !status.adapterVersion.isEmpty,
                  ["unverified", "verified"].contains(status.writeVerification) else { throw LauncherError.capabilityUnavailable }
            guard process.isRunning(identity: instance) else { throw failed(.connectedIdentity, .disconnected) }
            _ = try await startupEvaluate("window.__ncmOrganizerV1.show()", expected: instance)
            connectedPID = pid
            connected = true
            return status
        } catch {
            recordFailure(FailureRecord(stage: .connect, failure: FailureKind(error)))
            await disconnect()
            if let launched, error as? LauncherError == .unsafeListener, process.isRunning(identity: launched) {
                try await process.terminateNormally(expected: launched)
            }
            if error is DecodingError { throw LauncherError.capabilityUnavailable }
            throw error
        }
    }

    private func failed(_ stage: FailureStage, _ error: LauncherError) -> LauncherError {
        recordFailure(FailureRecord(stage: stage, failure: FailureKind(error)))
        return error
    }

    private func validateListener(_ listener: PortInspection, expectedPID: Int32) throws {
        if listener.hasUnsafeBinding(ownedBy: expectedPID) { throw LauncherError.unsafeListener }
        switch listener {
        case .owned(let pid, let loopback):
            guard pid == expectedPID else { throw LauncherError.portOccupied }
            guard loopback else { throw LauncherError.unsafeListener }
        case .conflict: throw LauncherError.portOccupied
        case .free: throw LauncherError.disconnected
        }
    }

    private func waitForDebugInstance(expected: ClientIdentity) async throws {
        try await validateStartupInstance(expected, until: Date().addingTimeInterval(15), allowFree: true)
    }

    // Only a boolean page readiness probe; real adapter capability detection remains in TS.
    static let frontendReadiness = "Boolean(typeof document !== 'undefined' && document.body && (document.readyState === 'interactive' || document.readyState === 'complete') && typeof window !== 'undefined' && window.webpackJsonp && typeof window.webpackJsonp.push === 'function')"

    // Startup only: ambiguous ownership is observed, never accepted. The caller owns the deadline.
    func validateStartupInstance(_ expected: ClientIdentity, until deadline: Date, allowFree: Bool = false) async throws {
        while true {
            try Task.checkCancellation()
            guard process.isRunning(identity: expected) else { throw failed(.startupIdentity, .disconnected) }
            let state = process.inspect()
            if case .unsupported = state { throw LauncherError.unsupportedClient }
            switch state {
            case .debug(let pid, let port):
                guard pid == expected.pid, port == Self.debugPort else { throw failed(.startupState, .disconnected) }
            case .regular(let pid): guard pid == expected.pid else { throw failed(.startupState, .disconnected) }
            case .notRunning, .unsupported: throw failed(.startupState, .disconnected)
            }
            let listener = try process.inspectListener(port: Self.debugPort)
            if listener.hasUnsafeBinding(ownedBy: expected.pid) { throw LauncherError.unsafeListener }
            if listener.isLoopbackConflict || (allowFree && listener == .free) {
                guard Date() < deadline else { throw listener.isConflict ? LauncherError.portOccupied : LauncherError.timeout }
                try await Task.sleep(nanoseconds: UInt64(min(0.1, max(0, deadline.timeIntervalSinceNow)) * 1_000_000_000))
                continue
            }
            try validateListener(listener, expectedPID: expected.pid)
            guard case .debug = state else { throw failed(.startupState, .disconnected) }
            try Task.checkCancellation()
            guard Date() < deadline else { throw LauncherError.timeout }
            return
        }
    }

    private func startupEvaluate(_ expression: String, expected: ClientIdentity, until phaseDeadline: Date? = nil) async throws -> JSONValue {
        let deadline = phaseDeadline ?? Date().addingTimeInterval(15)
        try await validateStartupInstance(expected, until: deadline)
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw LauncherError.timeout }
        let value = try await evaluate(expression, timeout: remaining)
        try await validateStartupInstance(expected, until: deadline)
        return value
    }

    private func waitForFrontend(expected: ClientIdentity) async throws {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            try Task.checkCancellation()
            do {
                let remaining = deadline.timeIntervalSinceNow
                guard remaining > 0 else { throw LauncherError.timeout }
                let result = try await startupEvaluate(Self.frontendReadiness, expected: expected, until: deadline)
                try Task.checkCancellation()
                guard Date() < deadline else { throw LauncherError.timeout }
                guard let ready = result.boolValue else { throw LauncherError.protocolFailure }
                if ready { return }
            } catch LauncherError.contextUnavailable {
                try Task.checkCancellation(); try await validateStartupInstance(expected, until: deadline)
            }
            try await Task.sleep(nanoseconds: UInt64(min(0.1, max(0, deadline.timeIntervalSinceNow)) * 1_000_000_000))
        }
        throw LauncherError.timeout
    }

    private func evaluate(_ expression: String, timeout: TimeInterval = 15) async throws -> JSONValue {
        guard let debug else { throw LauncherError.disconnected }
        let result = try await debug.call(method: "Runtime.evaluate", params: [
            "expression": .string(expression), "returnByValue": .bool(true), "awaitPromise": .bool(true)
        ], timeout: timeout)
        guard result["exceptionDetails"] == nil, let remote = result["result"] else { throw LauncherError.protocolFailure }
        if remote["type"] == .string("undefined") { return .null }
        guard let value = remote["value"] else { throw LauncherError.protocolFailure }
        return value
    }

    func removePanel() async throws {
        guard !busy else { throw LauncherError.operationInProgress }
        busy = true; defer { busy = false }
        _ = try await evaluate("window.__ncmOrganizerV1 && window.__ncmOrganizerV1.remove()")
    }

    // The menu owns explicit user choice and playback-interruption disclosure.
    func restoreNormalLaunch() async throws {
        guard !busy else { throw LauncherError.operationInProgress }
        busy = true; defer { busy = false }
        await disconnect()
        switch process.inspect() {
        case .unsupported: throw LauncherError.unsupportedClient
        case .regular: return
        case .notRunning: break
        case .debug(let pid, _):
            let approvedInstance = try process.captureIdentity(pid: pid)
            let listener = try process.inspectListener(port: Self.debugPort)
            if case .owned(let owner, _) = listener, owner != pid { throw LauncherError.portOccupied }
            if listener.isConflict { throw LauncherError.portOccupied }
            try await process.terminateNormally(expected: approvedInstance)
            guard try process.inspectListener(port: Self.debugPort) == .free else { throw LauncherError.portOccupied }
        }
        _ = try await process.start(debugPort: nil)
    }

    func clientDidExit(pid: Int32? = nil) async {
        if let pid, pid != connectedPID { return }
        await disconnect() // Deliberately does not relaunch.
    }
    func refreshConnection() async {
        guard !busy, connected, let debug else { return }
        let generation = connectionGeneration
        let isOpen = await debug.isOpen()
        // A reconnect can complete while the old transport health check is suspended.
        guard !busy, connected, connectionGeneration == generation else { return }
        guard isOpen, case .debug(let pid, _) = process.inspect(), pid == connectedPID else {
            await disconnect(); return
        }
        do { try validateListener(process.inspectListener(port: Self.debugPort), expectedPID: pid) }
        catch { await disconnect() }
    }
    func disconnect() async {
        connectionGeneration &+= 1
        connected = false; connectedPID = nil
        let old = debug; debug = nil
        await old?.close()
    }
}
