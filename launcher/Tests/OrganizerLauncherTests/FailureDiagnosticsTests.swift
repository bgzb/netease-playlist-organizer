import Testing
import Foundation
import Darwin
@testable import OrganizerLauncher

struct FailureDiagnosticsTests {
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ncm-failure-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        return url
    }
    private var sample: FailureRecord {
        FailureRecord(stage: .currentIdentity, failure: .disconnected, identity: IdentityFailure(
            capturedPresent: true, capturedTerminated: false, currentCountIsOne: true,
            currentPidMatches: true, currentStartedAtMatches: false, identityPresent: true))
    }
    @Test func testPrivateBoundedOwnFileContainsOnlyFixedStagesAndBooleans() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("own")
        let log = FailureLog(directory: directory)
        log.append(sample)
        let file = directory.appendingPathComponent(FailureLog.filename)
        let data = try Data(contentsOf: file)
        #expect(data.starts(with: FailureLog.header))
        let line = try #require(String(data: data, encoding: .utf8)?.split(separator: "\n").last)
        let record = try #require(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        #expect(Set(record.keys) == ["stage", "failure", "identity"])
        #expect(record["stage"] as? String == "currentIdentity")
        let details = try #require(record["identity"] as? [String: Bool])
        #expect(details.count == 6)
        #expect(details["currentStartedAtMatches"] == false)
        let fileMode = try #require(FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)
        let dirMode = try #require(FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)
        #expect(fileMode.intValue == 0o600); #expect(dirMode.intValue == 0o700)
        for _ in 0..<200 { log.append(sample) }
        let full = try Data(contentsOf: file)
        #expect(full.count <= FailureLog.limit)
        #expect(full.last == 10)
        log.append(sample)
        #expect(try Data(contentsOf: file) == full)
    }
    @Test func testSymlinkHardlinkForeignContentsAndLoosePermissionsRemainUntouched() throws {
        for variant in ["directorySymlink", "fileSymlink", "hardlink", "foreignContents", "looseDirectory", "looseFile", "fifo"] {
            let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
            let directory = root.appendingPathComponent("own"), target = root.appendingPathComponent("third-party")
            let sentinel = Data("DO NOT TOUCH".utf8)
            try sentinel.write(to: target)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            if variant == "directorySymlink" {
                try FileManager.default.createSymbolicLink(at: directory, withDestinationURL: root)
            } else {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: variant == "looseDirectory" ? 0o755 : 0o700])
                let file = directory.appendingPathComponent(FailureLog.filename)
                switch variant {
                case "fileSymlink": try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
                case "hardlink": try FileManager.default.linkItem(at: target, to: file)
                case "fifo": #expect(mkfifo(file.path, 0o600) == 0)
                case "looseFile":
                    try FailureLog.header.write(to: file)
                    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
                default:
                    try sentinel.write(to: file)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                }
            }
            FailureLog(directory: directory).append(sample)
            #expect(try Data(contentsOf: target) == sentinel)
            if ["foreignContents", "looseDirectory"].contains(variant) {
                #expect(try Data(contentsOf: directory.appendingPathComponent(FailureLog.filename)) == sentinel)
            }
            if variant == "looseFile" {
                #expect(try Data(contentsOf: directory.appendingPathComponent(FailureLog.filename)) == FailureLog.header)
            }
            if variant == "directorySymlink" { #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent(FailureLog.filename).path)) }
        }
    }
    @Test func testArbitraryErrorPayloadCannotReachRecord() throws {
        let error = NSError(domain: "SECRET_URL", code: 999, userInfo: [NSLocalizedDescriptionKey: "SECRET_ACCOUNT"])
        let record = FailureRecord(stage: .ui, failure: FailureKind(error))
        let encoded = try JSONEncoder().encode(record)
        #expect(!String(decoding: encoded, as: UTF8.self).contains("SECRET"))
        #expect(record.failure == .other)
    }
}

@MainActor private final class DiagnosticApplication: ClientApplication {
    var value = ClientIdentity(pid: 10, startedAt: Date(timeIntervalSince1970: 100))
    var terminated = false
    var trace: (String) -> Void = { _ in }
    var identity: ClientIdentity? { trace("identity"); return value }
    var isTerminated: Bool { trace("terminated"); return terminated }
    var bundleURL: URL? { URL(fileURLWithPath: "/offline/client.app") }
    func terminate() -> Bool { terminated = true; return true }
}

@MainActor private final class DiagnosticRuntime: ClientRuntime {
    var apps: [any ClientApplication] = []
    var trace: (String) -> Void = { _ in }
    var running: [any ClientApplication] { trace("running"); return apps }
    var applicationURL: URL? { URL(fileURLWithPath: "/offline/client.app") }
    func version(at url: URL) -> (String, String) { ("3.1.1", "3019") }
    func arguments(pid: Int32) throws -> String { "" }
    func inspectListener(port: Int) throws -> PortInspection { .free }
    func open(at url: URL, debugPort: Int?, completion: @escaping @MainActor (Result<any ClientApplication, Error>) -> Void) {
        Issue.record("Identity diagnostic tests must not launch")
    }
}

@MainActor struct FailureIdentityOrderTests {
    @Test func testOriginalHealthyOrderAndOnlyPostFailureIdentityRecords() throws {
        var trace: [String] = [], records: [FailureRecord] = []
        let app = DiagnosticApplication(), runtime = DiagnosticRuntime()
        app.trace = { trace.append($0) }; runtime.trace = { trace.append($0) }; runtime.apps = [app]
        let process = ClientProcess(recordFailure: { records.append($0); trace.append("record") }, runtime: runtime)
        let captured = try process.captureIdentity(pid: 10)
        trace = []
        #expect(process.isRunning(identity: captured))
        #expect(trace == ["terminated", "running", "identity"])
        #expect(records.isEmpty)
        app.value = ClientIdentity(pid: 10, startedAt: Date(timeIntervalSince1970: 200))
        trace = []
        #expect(!process.isRunning(identity: captured))
        #expect(trace == ["terminated", "running", "identity", "identity", "record"])
        #expect(records.last?.stage == .currentIdentity)
        #expect(records.last?.identity?.currentPidMatches == true)
        #expect(records.last?.identity?.currentStartedAtMatches == false)
        app.terminated = true; trace = []
        #expect(!process.isRunning(identity: captured))
        #expect(trace == ["terminated", "running", "identity", "record"])
        #expect(records.last?.stage == .retainedIdentity)
        #expect(records.last?.identity?.capturedTerminated == true)
    }
    @Test func testCountGuardStillShortCircuitsIdentityUntilAfterDecision() throws {
        var trace: [String] = [], record: FailureRecord?
        let app = DiagnosticApplication(), runtime = DiagnosticRuntime()
        app.trace = { trace.append($0) }; runtime.trace = { trace.append($0) }; runtime.apps = [app]
        let process = ClientProcess(recordFailure: { record = $0; trace.append("record") }, runtime: runtime)
        let captured = try process.captureIdentity(pid: 10)
        runtime.apps = [app, DiagnosticApplication()]; trace = []
        #expect(!process.isRunning(identity: captured))
        // The identity sample is a single failure-only sample, after the count decision.
        #expect(trace == ["terminated", "running", "identity", "record"])
        #expect(record?.identity?.currentCountIsOne == false)
        #expect(record?.identity?.capturedPresent == true)
    }
}
