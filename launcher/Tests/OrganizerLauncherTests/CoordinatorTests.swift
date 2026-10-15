import Testing
import Foundation
import JavaScriptCore
@testable import OrganizerLauncher

@MainActor final class ProcessSpy: ClientProcessControlling {
    var state: ClientState = .notRunning
    var listener: PortInspection = .free
    var terminationCount = 0
    var startCount = 0
    var ports: [Int?] = []
    var unsafeAfterStart = false
    var replaceAfterStart = false
    var listenerValues: [PortInspection] = []
    func inspect() -> ClientState { state }
    func inspectListener(port: Int) throws -> PortInspection { listenerValues.isEmpty ? listener : listenerValues.removeFirst() }
    func captureIdentity(pid: Int32) throws -> ClientIdentity {
        let identity = ClientIdentity(pid: pid, startedAt: Date(timeIntervalSince1970: Double(pid)))
        guard isRunning(identity: identity) else { throw LauncherError.disconnected }
        return identity
    }
    func isRunning(identity: ClientIdentity) -> Bool {
        switch state {
        case .regular(let pid), .debug(let pid, _): return pid == identity.pid
        default: return false
        }
    }
    func start(debugPort: Int?) async throws -> ClientIdentity {
        startCount += 1; ports.append(debugPort)
        if let port = debugPort {
            state = .debug(pid: 10, port: port)
            listener = .owned(pid: 10, loopback: !unsafeAfterStart)
        } else { state = .regular(pid: 10); listener = .free }
        if replaceAfterStart { state = .debug(pid: 20, port: 19319); listener = .owned(pid: 20, loopback: false) }
        return ClientIdentity(pid: 10, startedAt: Date(timeIntervalSince1970: 10))
    }
    func terminateNormally(expected: ClientIdentity) async throws {
        guard isRunning(identity: expected) else { throw LauncherError.disconnected }
        terminationCount += 1; state = .notRunning; listener = .free
    }
}

@MainActor final class DebugSpy: DebugCalling {
    var expressions: [String] = []
    var closeCount = 0
    var ready = true
    var frontendValues: [JSONValue] = []
    var frontendDefault: JSONValue = .bool(true)
    var onFrontend: (() -> Void)?
    var missingContexts = 0
    var observedTimeouts: [TimeInterval] = []
    var suspendHealth = false
    var healthContinuation: CheckedContinuation<Bool, Never>?
    func call(method: String, params: [String: JSONValue]) async throws -> JSONValue {
        expressions.append(params["expression"]?.stringValue ?? "")
        if expressions.last!.contains("document.readyState") {
            onFrontend?()
            if missingContexts > 0 { missingContexts -= 1; throw LauncherError.contextUnavailable }
            return .object(["result": .object(["value": frontendValues.isEmpty ? frontendDefault : frontendValues.removeFirst()])])
        }
        if expressions.last!.contains(".status()") {
            return .object(["result": .object(["value": .object([
                "installed": .bool(true), "adapterVersion": .string("3019-v1"),
                "readReady": .bool(ready), "writeVerification": .string("unverified")
            ])])])
        }
        return .object(["result": .object(["type": .string("undefined")])])
    }
    func call(method: String, params: [String: JSONValue], timeout: TimeInterval) async throws -> JSONValue {
        observedTimeouts.append(timeout); return try await call(method: method, params: params)
    }
    func close() async { closeCount += 1 }
    func isOpen() async -> Bool {
        if suspendHealth { return await withCheckedContinuation { healthContinuation = $0 } }
        return closeCount == 0
    }
    func completeHealth(_ value: Bool) { healthContinuation?.resume(returning: value); healthContinuation = nil }
}

@MainActor final class ConnectorSpy: DebugConnecting {
    var connectionCount = 0
    var clients: [DebugSpy] = []
    var ready = true
    var configure: ((DebugSpy) -> Void)?
    func connect(port: Int) async throws -> any DebugCalling {
        connectionCount += 1
        let client = DebugSpy(); client.ready = ready; configure?(client); clients.append(client)
        return client
    }
}

@MainActor final class CoordinatorTests {
    @Test func testStartupReplacementIsNeverTerminatedOrConnected() async {
        let process = ProcessSpy(); process.replaceAfterStart = true
        let connector = ConnectorSpy(); let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        do { _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false); Issue.record("Expected disappeared launched instance") }
        catch { #expect(error as? LauncherError == .disconnected) }
        #expect(process.terminationCount == 0); #expect(connector.connectionCount == 0)
        #expect(process.state == .debug(pid: 20, port: 19319))
    }

    @Test func testSuspendedOldHealthResultCannotDisconnectSuccessfulReconnect() async throws {
        let process = ProcessSpy(); let connector = ConnectorSpy()
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false)
        let old = connector.clients[0]; old.suspendHealth = true
        let refresh = Task { await coordinator.refreshConnection() }
        while old.healthContinuation == nil { await Task.yield() }
        _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false)
        old.completeHealth(false)
        await refresh.value
        #expect(coordinator.connected); #expect(connector.clients[1].closeCount == 0)
    }

    @Test func testSocketDisconnectShowsDisconnectedWithoutRestart() async throws {
        let process = ProcessSpy(); let debug = ConnectorSpy()
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false)
        await debug.clients[0].close()
        await coordinator.refreshConnection()
        #expect(!coordinator.connected); #expect(process.startCount == 1)
    }

    @Test func testDelayedOldProcessExitDoesNotCloseReconnection() async throws {
        let process = ProcessSpy(); let debug = ConnectorSpy()
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false)
        process.state = .debug(pid: 20, port: 19319); process.listener = .owned(pid: 20, loopback: true)
        _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false)
        await coordinator.clientDidExit(pid: 10)
        #expect(coordinator.connected); #expect(debug.clients[1].closeCount == 0)
    }

    @Test func testExistingNonLoopbackInstanceIsNotTerminatedWithoutUserChoice() async {
        let process = ProcessSpy(); process.state = .debug(pid: 10, port: 19319); process.listener = .owned(pid: 10, loopback: false)
        let debug = ConnectorSpy(); let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        do { _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false); Issue.record("Expected unsafe listener") }
        catch { #expect(error as? LauncherError == .unsafeListener) }
        #expect(process.terminationCount == 0); #expect(debug.connectionCount == 0)
    }

    @Test func testRegularClientNeedsRestartApproval() async {
        let processSpy = ProcessSpy(); processSpy.state = .regular(pid: 10)
        let debugSpy = ConnectorSpy(); let coordinator = Coordinator(recordFailure: { _ in }, process: processSpy, connector: debugSpy)
        do { _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false); Issue.record("Expected approval gate") }
        catch { #expect(error as? LauncherError == .restartApprovalRequired) }
        #expect(processSpy.terminationCount == 0)
        #expect(processSpy.startCount == 0)
        #expect(debugSpy.connectionCount == 0)
    }

    @Test func testForeignPortDoesNotConnectOrTerminateOwner() async {
        let process = ProcessSpy(); process.listener = .owned(pid: 999, loopback: true)
        let debug = ConnectorSpy(); let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        do { _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: true); Issue.record("Expected occupied port") }
        catch { #expect(error as? LauncherError == .portOccupied) }
        #expect(process.terminationCount == 0); #expect(process.startCount == 0)
        #expect(debug.connectionCount == 0)
    }

    @Test func testUnsupportedNativeBuildDoesNotStart() async {
        let process = ProcessSpy(); process.state = .unsupported(version: "3.1.2", build: "3020")
        let debug = ConnectorSpy(); let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        do { _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: true); Issue.record("Expected unsupported") }
        catch { #expect(error as? LauncherError == .unsupportedClient) }
        #expect(process.startCount == 0); #expect(debug.connectionCount == 0)
    }

    @Test func testCapabilityFailureEvenWithMatchingBuildStopsLoading() async {
        let process = ProcessSpy(); process.state = .debug(pid: 10, port: 19319); process.listener = .owned(pid: 10, loopback: true)
        let debug = ConnectorSpy(); debug.ready = false
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        do { _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false); Issue.record("Expected capability failure") }
        catch { #expect(error as? LauncherError == .capabilityUnavailable) }
        #expect(!(coordinator.connected))
        #expect(debug.clients[0].closeCount == 1)
        #expect(!(debug.clients[0].expressions.contains { $0.contains(".show()") }))
    }

    @Test func testReconnectCreatesFreshConnection() async throws {
        let process = ProcessSpy(); let debug = ConnectorSpy()
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false)
        _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false)
        #expect(debug.connectionCount == 2); #expect(debug.clients[0].closeCount == 1)
        #expect(debug.clients[1].expressions.last == "window.__ncmOrganizerV1.show()")
    }

    @Test func testNonLoopbackNewInstanceIsNormallyTerminated() async {
        let process = ProcessSpy(); process.unsafeAfterStart = true
        let debug = ConnectorSpy(); let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        do { _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false); Issue.record("Expected unsafe listener") }
        catch { #expect(error as? LauncherError == .unsafeListener) }
        #expect(process.terminationCount == 1); #expect(debug.connectionCount == 0)
    }

    @Test func testRestoreStartsWithoutDebugArguments() async throws {
        let process = ProcessSpy(); let debug = ConnectorSpy()
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false)
        try await coordinator.restoreNormalLaunch()
        #expect(process.terminationCount == 1)
        #expect(process.ports.count == 2); #expect(process.ports[1] == nil)
        #expect(!(coordinator.connected))
    }

    @Test func testClientExitDoesNotAutomaticallyRestart() async throws {
        let process = ProcessSpy(); let debug = ConnectorSpy()
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: debug)
        _ = try await coordinator.connectAndLoad(script: "panel", restartApproved: false)
        process.state = .notRunning; process.listener = .free
        await coordinator.clientDidExit()
        #expect(!(coordinator.connected)); #expect(process.startCount == 1)
    }
}

final class LauncherInstanceTests {
    @Test func testSingleInstanceLockRejectsConcurrentOwnerAndAllowsRelease() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("organizer-test-\(UUID().uuidString).lock")
        defer { try? FileManager.default.removeItem(at: url) }
        var first: SingleInstanceLock? = try SingleInstanceLock(url: url)
        #expect(throws: (any Error).self) { try SingleInstanceLock(url: url) }
        withExtendedLifetime(first) {}
        first = nil
        let next = try SingleInstanceLock(url: url)
        withExtendedLifetime(next) {}
    }
}

@MainActor final class FakeClientApplication: ClientApplication {
    let identity: ClientIdentity?
    var bundleURL: URL? { URL(fileURLWithPath: "/offline/net-ease.app") }
    var isTerminated = false
    var terminationCount = 0
    init(pid: Int32, startedAt: TimeInterval) {
        identity = ClientIdentity(pid: pid, startedAt: Date(timeIntervalSince1970: startedAt))
    }
    func terminate() -> Bool { terminationCount += 1; isTerminated = true; return true }
}

@MainActor final class FakeClientRuntime: ClientRuntime {
    var applicationURL: URL? { URL(fileURLWithPath: "/offline/net-ease.app") }
    var applications: [FakeClientApplication] = []
    var running: [any ClientApplication] { applications.filter { !$0.isTerminated } }
    var listener: PortInspection = .free
    var completion: (@MainActor (Result<any ClientApplication, Error>) -> Void)?
    func version(at url: URL) -> (String, String) { ("3.1.1", "3019") }
    func arguments(pid: Int32) throws -> String { "--remote-debugging-port=19319" }
    func inspectListener(port: Int) throws -> PortInspection { listener }
    func open(at url: URL, debugPort: Int?, completion: @escaping @MainActor (Result<any ClientApplication, Error>) -> Void) {
        self.completion = completion
    }
    func complete(_ app: FakeClientApplication) { completion?(.success(app)); completion = nil }
}

@MainActor final class ClientProcessLifecycleTests {
    @Test func testExpectedIdentityTerminationRefusesReplacementIncludingPIDReuse() async throws {
        let runtime = FakeClientRuntime()
        let old = FakeClientApplication(pid: 10, startedAt: 100); runtime.applications = [old]
        let process = ClientProcess(recordFailure: { _ in }, runtime: runtime)
        let identity = try process.captureIdentity(pid: 10)
        // Simulate a stale retained handle whose termination notification has not arrived.
        let replacement = FakeClientApplication(pid: 10, startedAt: 200); runtime.applications = [replacement]
        do { try await process.terminateNormally(expected: identity); Issue.record("Expected old identity rejection") }
        catch { #expect(error as? LauncherError == .disconnected) }
        #expect(old.terminationCount == 0); #expect(replacement.terminationCount == 0)
    }

    @Test func testLateUnsafeLaunchCallbackTerminatesOnlyItsRetainedInstance() async throws {
        let runtime = FakeClientRuntime(); let process = ClientProcess(recordFailure: { _ in }, runtime: runtime, launchTimeout: 0.02)
        do { _ = try await process.start(debugPort: 19319); Issue.record("Expected launch timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        let launched = FakeClientApplication(pid: 10, startedAt: 100)
        runtime.applications = [launched]; runtime.listener = .owned(pid: 10, loopback: false)
        runtime.complete(launched)
        for _ in 0..<200 where launched.terminationCount == 0 { await Task.yield() }
        #expect(launched.terminationCount == 1)
    }

    @Test func testLateCallbackCannotTerminateReplacementInstance() async throws {
        let runtime = FakeClientRuntime(); let process = ClientProcess(recordFailure: { _ in }, runtime: runtime, launchTimeout: 0.02)
        do { _ = try await process.start(debugPort: 19319); Issue.record("Expected launch timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        let launched = FakeClientApplication(pid: 10, startedAt: 100) // Stale handle may still report alive.
        let replacement = FakeClientApplication(pid: 20, startedAt: 200)
        runtime.applications = [replacement]; runtime.listener = .owned(pid: 20, loopback: false)
        runtime.complete(launched)
        for _ in 0..<20 { await Task.yield() }
        #expect(launched.terminationCount == 0); #expect(replacement.terminationCount == 0)
    }
}


@MainActor final class FrontendStartupTests {
    private func running() -> ProcessSpy {
        let process = ProcessSpy(); process.state = .debug(pid: 10, port: 19319)
        process.listener = .owned(pid: 10, loopback: true); return process
    }
    @Test func testLoadingAndMissingWebpackWaitBeforeSingleInjection() async throws {
        let process = running(); let connector = ConnectorSpy()
        connector.configure = { $0.frontendValues = [.bool(false), .bool(false), .bool(true)] }
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        _ = try await coordinator.connectAndLoad(script: "ACTUAL_PANEL", restartApproved: false)
        let expressions = connector.clients[0].expressions
        #expect(expressions.filter { $0.contains("document.readyState") }.count == 3)
        #expect(expressions.firstIndex(of: "ACTUAL_PANEL") == 3)
        #expect(expressions.filter { $0 == "ACTUAL_PANEL" }.count == 1)
        #expect(coordinator.connected); #expect(process.startCount == 0)
    }
    @Test func testNeverReadyTimesOutWithoutInjectionOrRelaunch() async {
        let process = running(); let connector = ConnectorSpy(); connector.configure = { $0.frontendDefault = .bool(false) }
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        do { _ = try await coordinator.connectAndLoad(script: "ACTUAL_PANEL", restartApproved: false); Issue.record("Expected readiness timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        #expect(!connector.clients[0].expressions.contains("ACTUAL_PANEL")); #expect(connector.clients[0].closeCount == 1)
        #expect(process.startCount == 0); #expect(process.terminationCount == 0)
    }
    @Test func testReplacementDuringFrontendWaitCannotReceivePanel() async {
        let process = running(); let connector = ConnectorSpy(); connector.configure = { client in
            client.onFrontend = { process.state = .debug(pid: 20, port: 19319); process.listener = .owned(pid: 20, loopback: true) }
        }
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        do { _ = try await coordinator.connectAndLoad(script: "ACTUAL_PANEL", restartApproved: false); Issue.record("Expected identity replacement rejection") }
        catch { #expect(error as? LauncherError == .disconnected) }
        #expect(!connector.clients[0].expressions.contains("ACTUAL_PANEL")); #expect(process.terminationCount == 0)
    }
    @Test func testUnsafeListenerDuringFrontendWaitFailsClosed() async {
        let process = running(); let connector = ConnectorSpy(); connector.configure = { client in
            client.onFrontend = { process.listener = .owned(pid: 10, loopback: false) }
        }
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        do { _ = try await coordinator.connectAndLoad(script: "ACTUAL_PANEL", restartApproved: false); Issue.record("Expected unsafe listener") }
        catch { #expect(error as? LauncherError == .unsafeListener) }
        #expect(!connector.clients[0].expressions.contains("ACTUAL_PANEL")); #expect(process.terminationCount == 0)
    }
    @Test func testCancellationDuringReadinessClosesWithoutInjection() async {
        let process = running(); let connector = ConnectorSpy(); connector.configure = { $0.frontendDefault = .bool(false) }
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        let operation = Task { try await coordinator.connectAndLoad(script: "ACTUAL_PANEL", restartApproved: false) }
        try? await Task.sleep(nanoseconds: 2_000_000); operation.cancel()
        do { _ = try await operation.value; Issue.record("Expected cancellation") }
        catch { #expect(error is CancellationError) }
        #expect(!connector.clients[0].expressions.contains("ACTUAL_PANEL")); #expect(connector.clients[0].closeCount == 1)
        #expect(process.startCount == 0); #expect(process.terminationCount == 0)
    }
    @Test func testMalformedFrontendBooleanIsNotRetriedAsNotReady() async {
        let process = running(); let connector = ConnectorSpy(); connector.configure = { $0.frontendDefault = .string("true") }
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        do { _ = try await coordinator.connectAndLoad(script: "ACTUAL_PANEL", restartApproved: false); Issue.record("Expected malformed readiness rejection") }
        catch { #expect(error as? LauncherError == .protocolFailure) }
        #expect(!connector.clients[0].expressions.contains("ACTUAL_PANEL"))
        #expect(connector.clients[0].expressions.filter { $0.contains("document.readyState") }.count == 1)
    }
}


@MainActor final class FrontendContextTests {
    @Test func testTransientContextAbsenceThenReadyInjectsOnlyOnce() async throws {
        let process = ProcessSpy(); let connector = ConnectorSpy(); connector.configure = { $0.missingContexts = 1 }
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        _ = try await coordinator.connectAndLoad(script: "ACTUAL_PANEL", restartApproved: false)
        #expect(connector.clients[0].expressions.filter { $0.contains("document.readyState") }.count == 2)
        #expect(connector.clients[0].expressions.filter { $0 == "ACTUAL_PANEL" }.count == 1)
    }
    @Test func testPIDReuseDuringReadinessIsRejectedByCapturedStartIdentity() async {
        let runtime = FakeClientRuntime(); runtime.applications = [FakeClientApplication(pid: 10, startedAt: 100)]
        runtime.listener = .owned(pid: 10, loopback: true)
        let process = ClientProcess(recordFailure: { _ in }, runtime: runtime); let connector = ConnectorSpy()
        connector.configure = { client in client.onFrontend = { runtime.applications = [FakeClientApplication(pid: 10, startedAt: 200)] } }
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        do { _ = try await coordinator.connectAndLoad(script: "ACTUAL_PANEL", restartApproved: false); Issue.record("Expected PID reuse rejection") }
        catch { #expect(error as? LauncherError == .disconnected) }
        #expect(!connector.clients[0].expressions.contains("ACTUAL_PANEL")); #expect(connector.clients[0].closeCount == 1)
        #expect(runtime.applications[0].terminationCount == 0)
    }
    @Test func testReadinessPredicateOnSyntheticJavaScriptLoadingAndWebpackStates() throws {
        let context = try #require(JSContext())
        for (setup, ready) in [
            ("var document={body:{},readyState:'loading'};var window={webpackJsonp:{push:function(){}}}", false),
            ("document.readyState='interactive';window.webpackJsonp={}", false),
            ("window.webpackJsonp.push=function(){}", true),
            ("document.body=null", false),
            ("document.body={};document.readyState='complete'", true)
        ] {
            context.evaluateScript(setup)
            let result = try #require(context.evaluateScript(Coordinator.frontendReadiness))
            #expect(result.isBoolean); #expect(result.toBool() == ready)
        }
    }
}


@MainActor final class StartupConflictTests {
    private func running() -> ProcessSpy {
        let process = ProcessSpy(); process.state = .debug(pid: 10, port: 19319)
        process.listener = .owned(pid: 10, loopback: true); return process
    }
    @Test func testConflictBeforeConnectionIsObservedWithoutAcceptingUntilExpectedOwner() async throws {
        let process = running(); process.listenerValues = [.owned(pid:10,loopback:true), .conflict(owners: [10: true, 999: true]), .owned(pid:10,loopback:true)]
        let connector = ConnectorSpy(); let coordinator = Coordinator(recordFailure: { _ in }, process:process,connector:connector)
        _ = try await coordinator.connectAndLoad(script:"ACTUAL_PANEL",restartApproved:false)
        #expect(connector.connectionCount == 1); #expect(coordinator.connected)
        #expect(process.startCount == 0); #expect(process.terminationCount == 0)
    }
    @Test func testConflictAfterSocketBeforeFrontendDropsCallsUntilStable() async throws {
        let process = running(); let connector = ConnectorSpy()
        connector.configure = { client in
            process.listener = .conflict(owners: [10: true, 999: true])
            DispatchQueue.main.asyncAfter(deadline:.now()+0.06) { process.listener = .owned(pid:10,loopback:true) }
            client.onFrontend = { #expect(process.listener == .owned(pid:10,loopback:true)) }
        }
        let coordinator = Coordinator(recordFailure: { _ in }, process:process,connector:connector)
        _ = try await coordinator.connectAndLoad(script:"ACTUAL_PANEL",restartApproved:false)
        #expect(coordinator.connected); #expect(connector.clients[0].expressions.filter{$0 == "ACTUAL_PANEL"}.count == 1)
    }
    @Test func testConflictAfterReadyBeforeInjectionDoesNotResetFrontendBudget() async throws {
        let process = running(); let connector = ConnectorSpy(); var checked = false
        connector.configure = { client in client.onFrontend = {
            if !checked { checked = true; process.listener = .conflict(owners: [10: true, 999: true])
                DispatchQueue.main.asyncAfter(deadline:.now()+0.08) { process.listener = .owned(pid:10,loopback:true) }
            }
        } }
        let coordinator = Coordinator(recordFailure: { _ in }, process:process,connector:connector)
        _ = try await coordinator.connectAndLoad(script:"ACTUAL_PANEL",restartApproved:false)
        #expect(process.listener == .owned(pid:10,loopback:true)); #expect(coordinator.connected)
        #expect(connector.clients[0].expressions.filter{$0 == "ACTUAL_PANEL"}.count == 1)
    }
    @Test func testCancelConflictObservationSendsNoPageCalls() async {
        let process = running(); let connector = ConnectorSpy(); connector.configure = { _ in process.listener = .conflict(owners: [10: true, 999: true]) }
        let coordinator = Coordinator(recordFailure: { _ in }, process:process,connector:connector)
        let operation = Task { try await coordinator.connectAndLoad(script:"ACTUAL_PANEL",restartApproved:false) }
        try? await Task.sleep(nanoseconds:20_000_000); operation.cancel()
        do { _ = try await operation.value; Issue.record("Expected cancellation during conflict") }
        catch { #expect(error is CancellationError) }
        #expect(connector.clients[0].expressions.isEmpty); #expect(process.terminationCount == 0)
    }
}

@MainActor final class StartupOwnershipBudgetTests {
    private func running() -> ProcessSpy { let p=ProcessSpy();p.state = .debug(pid:10,port:19319);p.listener = .owned(pid:10,loopback:true);return p }
    private let identity = ClientIdentity(pid:10,startedAt:Date(timeIntervalSince1970:10))
    @Test func testPersistentConflictFailsAtOriginalBudget() async {
        let p=running();p.listener = .conflict(owners: [10: true, 999: true]);let c=Coordinator(recordFailure: { _ in }, process:p,connector:ConnectorSpy());let start=Date()
        do { try await c.validateStartupInstance(identity,until:start.addingTimeInterval(0.04));Issue.record("Expected persistent conflict") }
        catch { #expect(error as? LauncherError == .portOccupied) }
        #expect(Date().timeIntervalSince(start)>=0.035);#expect(Date().timeIntervalSince(start)<0.2)
        #expect(p.startCount==0);#expect(p.terminationCount==0)
    }
    @Test func testForeignUnsafeAndReplacementAreImmediatelyTerminal() async {
        for (listener,error) in [(PortInspection.owned(pid:999,loopback:true),LauncherError.portOccupied),(.owned(pid:10,loopback:false),.unsafeListener)] {
            let p=running();p.listener=listener;let c=Coordinator(recordFailure: { _ in }, process:p,connector:ConnectorSpy());let start=Date()
            do { try await c.validateStartupInstance(identity,until:start.addingTimeInterval(15));Issue.record("Expected strict rejection") }
            catch let actual { #expect(actual as? LauncherError == error) }
            #expect(Date().timeIntervalSince(start)<0.1)
        }
        let p=running();p.state = .debug(pid:20,port:19319);p.listener = .conflict(owners: [10: true, 999: true])
        do { try await Coordinator(recordFailure: { _ in }, process:p,connector:ConnectorSpy()).validateStartupInstance(identity,until:Date().addingTimeInterval(15));Issue.record("Expected replaced identity") }
        catch { #expect(error as? LauncherError == .disconnected) }
    }
    @Test func testPostReadinessConflictWaitingIsDeductedFromInjectionCallBudget() async throws {
        let p=running();let connector=ConnectorSpy();connector.configure = { client in client.onFrontend = {
            // Frontend's post-check is owned; the next injection pre-check sees conflict.
            p.listenerValues = [.owned(pid:10,loopback:true),.conflict(owners: [10: true, 999: true])]
        } }
        _ = try await Coordinator(recordFailure: { _ in }, process:p,connector:connector).connectAndLoad(script:"ACTUAL_PANEL",restartApproved:false)
        let client=connector.clients[0];let index=try #require(client.expressions.firstIndex(of:"ACTUAL_PANEL"))
        #expect(client.observedTimeouts[index]<14.97);#expect(client.observedTimeouts[index]>14.5)
        #expect(client.expressions.filter{$0 == "ACTUAL_PANEL"}.count==1)
    }
    @Test func testOrdinaryMonitorStillTerminatesConflictWithoutWaiting() async throws {
        let p=running();let connector=ConnectorSpy();let c=Coordinator(recordFailure: { _ in }, process:p,connector:connector)
        _ = try await c.connectAndLoad(script:"ACTUAL_PANEL",restartApproved:false)
        p.listener = .conflict(owners: [10: true, 999: true]);let start=Date();await c.refreshConnection()
        #expect(!c.connected);#expect(connector.clients[0].closeCount==1);#expect(Date().timeIntervalSince(start)<0.1)
    }
}

@MainActor final class MultiOwnerSafetyTests {
    private func mixed(expectedUnsafe: Bool, foreignUnsafe: Bool = false) throws -> PortInspection {
        let own = expectedUnsafe ? "*" : "127.0.0.1"
        let foreign = foreignUnsafe ? "*" : "127.0.0.1"
        return try ListenerInspector.parse("p10\nn\(own):19319\np999\nn\(foreign):19319\n", port: 19319)
    }
    @Test func testExpectedWildcardWithSecondOwnerFailsImmediatelyAndCleansOnlyLaunchedIdentity() async throws {
        let process = ProcessSpy()
        process.listenerValues = [.free, try mixed(expectedUnsafe: true)]
        let connector = ConnectorSpy()
        let began = Date()
        do {
            _ = try await Coordinator(recordFailure: { _ in }, process: process, connector: connector).connectAndLoad(script: "PANEL", restartApproved: false)
            Issue.record("Expected unsafe launched owner rejection")
        } catch { #expect(error as? LauncherError == .unsafeListener) }
        #expect(Date().timeIntervalSince(began) < 0.08)
        #expect(process.terminationCount == 1)
        #expect(process.startCount == 1)
        #expect(connector.connectionCount == 0)
    }
    @Test func testForeignWildcardConflictIsTerminalWithoutTerminatingEitherOwner() async throws {
        let process = ProcessSpy()
        process.listenerValues = [.free, try mixed(expectedUnsafe: false, foreignUnsafe: true)]
        let connector = ConnectorSpy()
        do {
            _ = try await Coordinator(recordFailure: { _ in }, process: process, connector: connector).connectAndLoad(script: "PANEL", restartApproved: false)
            Issue.record("Expected foreign unsafe conflict rejection")
        } catch { #expect(error as? LauncherError == .portOccupied) }
        #expect(process.terminationCount == 0)
        #expect(connector.connectionCount == 0)
    }
    @Test func testParsedSafeConflictWaitsForUniqueExpectedOwnerWithoutExtraLaunch() async throws {
        let process = ProcessSpy()
        process.listenerValues = [.free, try mixed(expectedUnsafe: false)]
        let connector = ConnectorSpy()
        let coordinator = Coordinator(recordFailure: { _ in }, process: process, connector: connector)
        _ = try await coordinator.connectAndLoad(script: "PANEL", restartApproved: false)
        #expect(coordinator.connected)
        #expect(process.startCount == 1)
        #expect(process.terminationCount == 0)
        #expect(connector.connectionCount == 1)
    }
    @Test func testReplacementIdentityWithUnsafeMultiOwnerIsNeverTerminatedOrConnected() async throws {
        let process = ProcessSpy(); process.replaceAfterStart = true
        process.listenerValues = [.free, try mixed(expectedUnsafe: true)]
        let connector = ConnectorSpy()
        do {
            _ = try await Coordinator(recordFailure: { _ in }, process: process, connector: connector).connectAndLoad(script: "PANEL", restartApproved: false)
            Issue.record("Expected replaced identity rejection")
        } catch { #expect(error as? LauncherError == .disconnected) }
        #expect(process.terminationCount == 0)
        #expect(connector.connectionCount == 0)
    }
    @Test func testAbandonedLaunchStillCleansExpectedUnsafeBindingAmongMultipleOwners() async throws {
        let runtime = FakeClientRuntime()
        let process = ClientProcess(recordFailure: { _ in }, runtime: runtime, launchTimeout: 0.01)
        do { _ = try await process.start(debugPort: 19319); Issue.record("Expected timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        let launched = FakeClientApplication(pid: 10, startedAt: 100)
        runtime.applications = [launched]
        runtime.listener = try mixed(expectedUnsafe: true)
        runtime.complete(launched)
        for _ in 0..<200 where launched.terminationCount == 0 { await Task.yield() }
        #expect(launched.terminationCount == 1)
    }
    @Test func testAbandonedMultiOwnerEvidenceCannotTerminateSamePIDReplacement() async throws {
        let runtime = FakeClientRuntime()
        let process = ClientProcess(recordFailure: { _ in }, runtime: runtime, launchTimeout: 0.01)
        do { _ = try await process.start(debugPort: 19319); Issue.record("Expected timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        let launched = FakeClientApplication(pid: 10, startedAt: 100)
        let replacement = FakeClientApplication(pid: 10, startedAt: 200)
        runtime.applications = [replacement]
        runtime.listener = try mixed(expectedUnsafe: true)
        runtime.complete(launched)
        for _ in 0..<20 { await Task.yield() }
        #expect(launched.terminationCount == 0)
        #expect(replacement.terminationCount == 0)
    }
}
